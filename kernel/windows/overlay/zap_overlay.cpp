/*
 * zap_overlay.cpp — In-process D3D11 overlay renderer for Zap.
 *
 * Loaded into the host process. Builds a throwaway swapchain to steal the
 * IDXGISwapChain vtable, hooks Present (idx 8) and ResizeBuffers (idx 13)
 * with MinHook, then rebinds a render-target view on the real swapchain the
 * first time Present fires. The caller registers a draw callback via
 * zap_overlay_set_draw_callback and issues its D3D11 draws from there —
 * everything renders inside the host's own render loop, so there is no
 * top-level overlay window for window-enumeration scanners to find.
 *
 * BUILD (from VS x64 Native Tools prompt):
 *   cl /LD /O2 /EHsc /DZAP_OVERLAY_EXPORTS zap_overlay.cpp ^
 *      /I<minhook_include> <minhook_lib>\libMinHook.x64.lib ^
 *      /Fe:zap_overlay.dll /link d3d11.lib dxgi.lib user32.lib
 *
 * Copyright (c) 2026 Zap AI. PROPRIETARY AND CONFIDENTIAL.
 */

#define ZAP_OVERLAY_EXPORTS
#include "zap_overlay.h"

#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <atomic>
#include <mutex>

#include "MinHook.h"

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")

/* ── vtable indices for IDXGISwapChain ── */
static const size_t VT_PRESENT        = 8;
static const size_t VT_RESIZE_BUFFERS = 13;

/* ── original function pointers ── */
using PresentFn       = HRESULT (STDMETHODCALLTYPE*)(IDXGISwapChain*, UINT, UINT);
using ResizeBuffersFn = HRESULT (STDMETHODCALLTYPE*)(IDXGISwapChain*, UINT, UINT, UINT, DXGI_FORMAT, UINT);

static PresentFn       g_oPresent       = nullptr;
static ResizeBuffersFn g_oResizeBuffers = nullptr;

/* ── cached host resources ── */
static ID3D11Device*           g_device  = nullptr;
static ID3D11DeviceContext*    g_context = nullptr;
static ID3D11RenderTargetView* g_rtv     = nullptr;
static UINT                    g_width   = 0;
static UINT                    g_height  = 0;

static std::atomic<bool> g_ready{false};
static std::atomic<bool> g_initialised{false};
static std::mutex        g_state_mx;

static zap_overlay_draw_fn g_draw_cb   = nullptr;
static void*               g_draw_user = nullptr;

/* ─────────────────────────────────────────────────────────────
 *  helpers
 * ───────────────────────────────────────────────────────────── */

static void release_rtv() {
    if (g_rtv) { g_rtv->Release(); g_rtv = nullptr; }
}

static void release_device() {
    release_rtv();
    if (g_context) { g_context->Release(); g_context = nullptr; }
    if (g_device)  { g_device->Release();  g_device  = nullptr; }
}

/* Build the RTV from the swapchain's back buffer. Must be called after any
 * ResizeBuffers so the view isn't pointing at a freed texture. */
static bool build_rtv_from(IDXGISwapChain* swap) {
    ID3D11Texture2D* back = nullptr;
    if (FAILED(swap->GetBuffer(0, __uuidof(ID3D11Texture2D), reinterpret_cast<void**>(&back))) || !back) {
        return false;
    }

    D3D11_TEXTURE2D_DESC desc = {};
    back->GetDesc(&desc);
    g_width  = desc.Width;
    g_height = desc.Height;

    HRESULT hr = g_device->CreateRenderTargetView(back, nullptr, &g_rtv);
    back->Release();
    return SUCCEEDED(hr) && g_rtv != nullptr;
}

/* ─────────────────────────────────────────────────────────────
 *  hooks
 * ───────────────────────────────────────────────────────────── */

static HRESULT STDMETHODCALLTYPE hk_Present(IDXGISwapChain* swap, UINT sync, UINT flags) {
    std::lock_guard<std::mutex> lk(g_state_mx);

    if (!g_device) {
        if (SUCCEEDED(swap->GetDevice(__uuidof(ID3D11Device), reinterpret_cast<void**>(&g_device)))) {
            g_device->GetImmediateContext(&g_context);
        }
    }

    if (g_device && !g_rtv) {
        build_rtv_from(swap);
    }

    if (g_device && g_context && g_rtv) {
        /* Preserve host state: rebinding our RTV and letting the callback
         * draw would clobber whatever the host had bound. Snapshot the
         * bindings we touch and restore before handing back control. */
        ID3D11RenderTargetView* prev_rtv  = nullptr;
        ID3D11DepthStencilView* prev_dsv  = nullptr;
        g_context->OMGetRenderTargets(1, &prev_rtv, &prev_dsv);

        UINT vp_count = 1;
        D3D11_VIEWPORT prev_vp = {};
        g_context->RSGetViewports(&vp_count, &prev_vp);

        D3D11_VIEWPORT vp = { 0.0f, 0.0f,
                              static_cast<float>(g_width),
                              static_cast<float>(g_height),
                              0.0f, 1.0f };
        g_context->RSSetViewports(1, &vp);
        g_context->OMSetRenderTargets(1, &g_rtv, nullptr);

        g_ready.store(true, std::memory_order_release);

        zap_overlay_draw_fn cb = g_draw_cb;
        void* user             = g_draw_user;
        if (cb) {
            cb(g_device, g_context, g_rtv, g_width, g_height, user);
        }

        g_context->OMSetRenderTargets(1, &prev_rtv, prev_dsv);
        if (vp_count > 0) g_context->RSSetViewports(1, &prev_vp);
        if (prev_rtv) prev_rtv->Release();
        if (prev_dsv) prev_dsv->Release();
    }

    return g_oPresent(swap, sync, flags);
}

static HRESULT STDMETHODCALLTYPE hk_ResizeBuffers(IDXGISwapChain* swap,
                                                  UINT buffer_count,
                                                  UINT width,
                                                  UINT height,
                                                  DXGI_FORMAT new_format,
                                                  UINT flags) {
    std::lock_guard<std::mutex> lk(g_state_mx);

    /* Must drop any view on the current back buffer or ResizeBuffers fails
     * with DXGI_ERROR_INVALID_CALL. */
    release_rtv();

    HRESULT hr = g_oResizeBuffers(swap, buffer_count, width, height, new_format, flags);

    if (SUCCEEDED(hr) && g_device) {
        build_rtv_from(swap);
    }
    return hr;
}

/* ─────────────────────────────────────────────────────────────
 *  vtable stealer — spin up a throwaway swapchain to read Present
 *  and ResizeBuffers slots, then release it.
 * ───────────────────────────────────────────────────────────── */

static bool install_hooks() {
    /* Wait until d3d11 is actually loaded — DLL may arrive early. */
    for (int i = 0; i < 100 && !GetModuleHandleW(L"d3d11.dll"); ++i) {
        Sleep(50);
    }

    WNDCLASSEXW wc = { sizeof(wc) };
    wc.lpfnWndProc   = DefWindowProcW;
    wc.hInstance     = GetModuleHandleW(nullptr);
    wc.lpszClassName = L"ZapOverlayProbe";
    RegisterClassExW(&wc);
    HWND hwnd = CreateWindowExW(0, wc.lpszClassName, L"", WS_OVERLAPPEDWINDOW,
                                0, 0, 2, 2, nullptr, nullptr, wc.hInstance, nullptr);
    if (!hwnd) {
        UnregisterClassW(wc.lpszClassName, wc.hInstance);
        return false;
    }

    DXGI_SWAP_CHAIN_DESC sd = {};
    sd.BufferCount        = 1;
    sd.BufferDesc.Format  = DXGI_FORMAT_R8G8B8A8_UNORM;
    sd.BufferDesc.Width   = 2;
    sd.BufferDesc.Height  = 2;
    sd.BufferUsage        = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    sd.OutputWindow       = hwnd;
    sd.SampleDesc.Count   = 1;
    sd.SwapEffect         = DXGI_SWAP_EFFECT_DISCARD;
    sd.Windowed           = TRUE;

    D3D_FEATURE_LEVEL levels[] = { D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_0 };
    D3D_FEATURE_LEVEL got;

    IDXGISwapChain*      probe_swap = nullptr;
    ID3D11Device*        probe_dev  = nullptr;
    ID3D11DeviceContext* probe_ctx  = nullptr;

    HRESULT hr = D3D11CreateDeviceAndSwapChain(
        nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0,
        levels, ARRAYSIZE(levels), D3D11_SDK_VERSION,
        &sd, &probe_swap, &probe_dev, &got, &probe_ctx);

    bool ok = false;
    if (SUCCEEDED(hr) && probe_swap) {
        void** vt = *reinterpret_cast<void***>(probe_swap);

        if (MH_Initialize() == MH_OK) {
            MH_STATUS s1 = MH_CreateHook(vt[VT_PRESENT], reinterpret_cast<LPVOID>(&hk_Present),
                                         reinterpret_cast<LPVOID*>(&g_oPresent));
            MH_STATUS s2 = MH_CreateHook(vt[VT_RESIZE_BUFFERS], reinterpret_cast<LPVOID>(&hk_ResizeBuffers),
                                         reinterpret_cast<LPVOID*>(&g_oResizeBuffers));
            if (s1 == MH_OK && s2 == MH_OK && MH_EnableHook(MH_ALL_HOOKS) == MH_OK) {
                ok = true;
            }
        }
    }

    if (probe_ctx)  probe_ctx->Release();
    if (probe_dev)  probe_dev->Release();
    if (probe_swap) probe_swap->Release();
    DestroyWindow(hwnd);
    UnregisterClassW(wc.lpszClassName, wc.hInstance);
    return ok;
}

/* ─────────────────────────────────────────────────────────────
 *  exported API
 * ───────────────────────────────────────────────────────────── */

extern "C" ZAP_OVL_API int zap_overlay_init(void) {
    bool expected = false;
    if (!g_initialised.compare_exchange_strong(expected, true)) {
        return 1; /* already initialised */
    }
    if (!install_hooks()) {
        g_initialised.store(false);
        return 0;
    }
    return 1;
}

extern "C" ZAP_OVL_API void zap_overlay_shutdown(void) {
    if (!g_initialised.exchange(false)) return;

    MH_DisableHook(MH_ALL_HOOKS);
    MH_Uninitialize();

    std::lock_guard<std::mutex> lk(g_state_mx);
    g_draw_cb   = nullptr;
    g_draw_user = nullptr;
    release_device();
    g_ready.store(false);
}

extern "C" ZAP_OVL_API void zap_overlay_set_draw_callback(zap_overlay_draw_fn cb, void* user) {
    std::lock_guard<std::mutex> lk(g_state_mx);
    g_draw_cb   = cb;
    g_draw_user = user;
}

extern "C" ZAP_OVL_API int zap_overlay_is_ready(void) {
    return g_ready.load(std::memory_order_acquire) ? 1 : 0;
}

/* ─────────────────────────────────────────────────────────────
 *  DllMain — auto-init on load so the DLL can be injected without
 *  the host having to call any exports first.
 * ───────────────────────────────────────────────────────────── */

static DWORD WINAPI init_thread(LPVOID) {
    zap_overlay_init();
    return 0;
}

BOOL APIENTRY DllMain(HMODULE mod, DWORD reason, LPVOID /*reserved*/) {
    switch (reason) {
    case DLL_PROCESS_ATTACH:
        DisableThreadLibraryCalls(mod);
        /* Never do heavy work inside DllMain — kick off a worker thread. */
        CreateThread(nullptr, 0, init_thread, nullptr, 0, nullptr);
        break;
    case DLL_PROCESS_DETACH:
        zap_overlay_shutdown();
        break;
    }
    return TRUE;
}
