import SwiftUI

@main
struct NectarDummyApp: App {
  var body: some Scene {
    WindowGroup { ContentView() }
  }
}

struct ContentView: View {
  @State private var count = 0
  @State private var note = ""
  @State private var sweet = false

  var body: some View {
    ZStack {
      (sweet ? Color(red: 0.95, green: 0.78, blue: 0.35) : Color(red: 0.16, green: 0.14, blue: 0.12))
        .ignoresSafeArea()
      VStack(spacing: 24) {
        Text("🍯 nectar dummy")
          .font(.largeTitle.bold())
        Text("taste it before it becomes honey")
          .font(.footnote)
          .opacity(0.7)

        Text("\(count)")
          .font(.system(size: 72, weight: .heavy, design: .monospaced))
          .contentTransition(.numericText())

        HStack(spacing: 16) {
          Button("−") { count -= 1 }
          Button("tap me") { withAnimation { count += 1 } }
            .buttonStyle(.borderedProminent)
          Button("+") { count += 1 }
        }
        .font(.title2)

        TextField("type here to test the keyboard", text: $note)
          .textFieldStyle(.roundedBorder)
          .padding(.horizontal, 32)

        Toggle("honey mode", isOn: $sweet.animation())
          .padding(.horizontal, 100)
      }
      .foregroundStyle(sweet ? Color.black : Color.white)
    }
  }
}
