import { BrowserHost } from "@effect/ui/html"
import { Effect, Layer } from "effect"
import { App } from "./App.ts"
import "./styles.css"

document.documentElement.dataset.platform = window.foc.platform

Layer.launch(BrowserHost.mount(App, {}, document.getElementById("app")!)).pipe(Effect.runFork)
