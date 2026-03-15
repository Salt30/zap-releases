import Cocoa

// Zap Clicker — tiny helper that clicks at absolute screen coordinates
// Usage: zap-clicker <x> <y>
// Uses CGWarpMouseCursorPosition to physically move cursor, then CGEvent at session tap

guard CommandLine.arguments.count >= 3,
      let x = Double(CommandLine.arguments[1]),
      let y = Double(CommandLine.arguments[2]) else {
    fputs("Usage: zap-clicker <x> <y>\n", stderr)
    exit(1)
}

let point = CGPoint(x: x, y: y)

// Step 1: Physically warp cursor to position (like a real mouse)
CGAssociateMouseAndMouseCursorPosition(0) // disconnect
CGWarpMouseCursorPosition(point)
CGAssociateMouseAndMouseCursorPosition(1) // reconnect
usleep(100000) // 100ms

// Step 2: Send mouse-moved at session level so OS updates cursor tracking
if let moveEvent = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
    moveEvent.post(tap: .cgSessionEventTap)
}
usleep(100000) // 100ms

// Step 3: Mouse down — post to session event tap with click count = 1
if let downEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left) {
    downEvent.setIntegerValueField(.mouseEventClickState, value: 1)
    downEvent.post(tap: .cgSessionEventTap)
}
usleep(80000) // 80ms

// Step 4: Mouse up — same position, same click count
if let upEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) {
    upEvent.setIntegerValueField(.mouseEventClickState, value: 1)
    upEvent.post(tap: .cgSessionEventTap)
}

fputs("click_done_at_\(Int(x))_\(Int(y))\n", stdout)
