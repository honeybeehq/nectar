// ax-dump — emit the macOS Accessibility tree of one app as NDJSON snapshots.
// Usage: ax-dump <pid> [intervalMs]
// Output schema matches serve-sim's /ax snapshots so desk/composer consumers are
// identical for ios streams and desktop testpacks:
//   {"screen":{"width","height"},"elements":[{id,path,label,value,role,type,enabled,frame}]}
// Exit 3 with {"error":"ax-not-trusted"} when the host process lacks Accessibility
// permission (System Settings > Privacy & Security > Accessibility).
import AppKit
import ApplicationServices
import Foundation

let arguments = CommandLine.arguments
guard arguments.count >= 2, let pid = pid_t(arguments[1]) else {
  FileHandle.standardError.write(Data("usage: ax-dump <pid> [intervalMs]\n".utf8))
  exit(2)
}
let intervalMs = arguments.count >= 3 ? Int(arguments[2]) ?? 0 : 0

func emitLine(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

guard AXIsProcessTrusted() else {
  emitLine([
    "error": "ax-not-trusted",
    "hint": "grant Accessibility permission to the terminal/app running nectar in System Settings > Privacy & Security > Accessibility",
  ])
  exit(3)
}

let typeMap: [String: (String, String)] = [
  "AXButton": ("Button", "button"),
  "AXPopUpButton": ("Button", "button"),
  "AXMenuButton": ("Button", "button"),
  "AXMenuItem": ("MenuItem", "menu item"),
  "AXTextField": ("TextField", "text field"),
  "AXTextArea": ("TextField", "text field"),
  "AXSearchField": ("TextField", "text field"),
  "AXStaticText": ("StaticText", "text"),
  "AXCheckBox": ("CheckBox", "checkbox"),
  "AXRadioButton": ("RadioButton", "radio"),
  "AXLink": ("Link", "link"),
  "AXImage": ("Image", "image"),
  "AXSlider": ("Slider", "slider"),
  "AXTabGroup": ("TabGroup", "tab group"),
]

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
  return value
}

func stringAttribute(_ element: AXUIElement, _ name: String) -> String {
  guard let value = attribute(element, name) else { return "" }
  if let text = value as? String { return text }
  if let number = value as? NSNumber { return number.stringValue }
  return ""
}

func frameOf(_ element: AXUIElement) -> CGRect? {
  guard let positionValue = attribute(element, kAXPositionAttribute),
        let sizeValue = attribute(element, kAXSizeAttribute)
  else { return nil }
  var point = CGPoint.zero
  var size = CGSize.zero
  guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &point),
        AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
  else { return nil }
  return CGRect(origin: point, size: size)
}

func snapshot(appElement: AXUIElement) -> [String: Any] {
  var elements: [[String: Any]] = []
  var emitted = 0

  func walk(_ element: AXUIElement, path: String, depth: Int) {
    if depth > 30 || emitted >= 800 { return }
    let role = stringAttribute(element, kAXRoleAttribute)
    var label = stringAttribute(element, kAXTitleAttribute)
    if label.isEmpty { label = stringAttribute(element, kAXDescriptionAttribute) }
    let rawValue = stringAttribute(element, kAXValueAttribute)
    if label.isEmpty && role == "AXStaticText" { label = rawValue }
    let enabled = (attribute(element, kAXEnabledAttribute) as? NSNumber)?.boolValue ?? true
    let mapped = typeMap[role]
    let interesting = mapped != nil || !label.isEmpty
    if interesting, let frame = frameOf(element), frame.width > 0, frame.height > 0 {
      elements.append([
        "id": path,
        "path": path,
        "label": label,
        "value": mapped?.0 == "StaticText" ? "" : rawValue,
        "role": mapped?.1 ?? "",
        "type": mapped?.0 ?? "GenericElement",
        "enabled": enabled,
        "frame": ["x": frame.origin.x, "y": frame.origin.y, "width": frame.width, "height": frame.height],
      ])
      emitted += 1
    }
    guard let childrenValue = attribute(element, kAXChildrenAttribute),
          let children = childrenValue as? [AXUIElement]
    else { return }
    for (index, child) in children.enumerated() {
      walk(child, path: "\(path).\(index)", depth: depth + 1)
    }
  }

  walk(appElement, path: "0", depth: 0)
  let screen = CGDisplayBounds(CGMainDisplayID())
  return [
    "screen": ["width": screen.width, "height": screen.height],
    "elements": elements,
  ]
}

let appElement = AXUIElementCreateApplication(pid)
// Electron disables its AX tree until an assistive client asks for it.
AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)

if intervalMs <= 0 {
  emitLine(snapshot(appElement: appElement))
  exit(0)
}
while kill(pid, 0) == 0 {
  emitLine(snapshot(appElement: appElement))
  usleep(useconds_t(intervalMs * 1_000))
}
exit(0)
