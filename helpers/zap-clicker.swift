import Cocoa

// Zap Clicker — tiny helper that clicks at absolute screen coordinates
// Usage: zap-clicker <x> <y>
// Requires Accessibility permission for the parent app

guard CommandLine.arguments.count >= 3,
      let x = Double(CommandLine.arguments[1]),
      let y = Double(CommandLine.arguments[2]) else {
    fputs("Usage: zap-clicker <x> <y>\n", stderr)
    exit(1)
}

let point = CGPoint(x: x, y: y)

// Move mouse to position first
if let moveEvent = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
    moveEvent.post(tap: .cghidEventTap)
}
usleep(30000) // 30ms

// Mouse down
if let downEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left) {
    downEvent.post(tap: .cghidEventTap)
}
usleep(50000) // 50ms

// Mouse up
if let upEvent = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) {
    upEvent.post(tap: .cghidEventTap)
}
