/*
 * zap_overlay.h — In-process D3D11 overlay renderer
 *
 * Injected into the host process, hooks IDXGISwapChain::Present and
 * IDXGISwapChain::ResizeBuffers, and gives the caller a draw surface
 * that lives inside the host's own render loop.
 *
 * Copyright (c) 2026 Zap AI. PROPRIETARY AND CONFIDENTIAL.
 */

#ifndef ZAP_OVERLAY_H
#define ZAP_OVERLAY_H

#ifdef __cplusplus
extern "C" {
#endif

#ifdef ZAP_OVERLAY_EXPORTS
#define ZAP_OVL_API __declspec(dllexport)
#else
#define ZAP_OVL_API __declspec(dllimport)
#endif

#include <stdint.h>

/* Draw callback — fired every Present after the RTV is bound.
 * Receives the host device + context so the caller can queue draws.
 * ID3D11Device*, ID3D11DeviceContext*, ID3D11RenderTargetView* are
 * opaque here to avoid dragging d3d11.h into consumers. */
typedef void (*zap_overlay_draw_fn)(void* device, void* context, void* rtv,
                                    uint32_t width, uint32_t height,
                                    void* user);

/* Initialise the overlay: locate d3d11.dll, build a dummy swapchain,
 * hook Present + ResizeBuffers via MinHook. Idempotent. */
ZAP_OVL_API int  zap_overlay_init(void);

/* Tear down hooks and release cached resources. */
ZAP_OVL_API void zap_overlay_shutdown(void);

/* Install the per-frame draw callback. NULL to clear. */
ZAP_OVL_API void zap_overlay_set_draw_callback(zap_overlay_draw_fn cb, void* user);

/* True once the first Present has run and the RTV is live. */
ZAP_OVL_API int  zap_overlay_is_ready(void);

#ifdef __cplusplus
}
#endif

#endif /* ZAP_OVERLAY_H */
