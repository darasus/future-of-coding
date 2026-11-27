import { Command, Component, UiSchema } from "@effect/ui"
import { Html } from "@effect/ui/html"
import { Effect, Layer, Redacted, Schema } from "effect"
import { AsyncResult } from "effect/reactivity"
import { Account } from "../../../shared/domain.ts"
import { GetSettings, SettingsTag } from "../queries.ts"
import { Bridge } from "../services/Bridge.ts"
import { Icon } from "./icons.ts"

const Secret = Schema.Redacted(Schema.String)

export const SettingsPanelMessage = UiSchema.TaggedEnum({
  UpdatedKey: { value: Secret },
  SubmittedKey: {},
  ClickedClearKey: {},
  ToggledSubscription: { checked: Schema.Boolean },
  ClickedFolder: {},
  UpdatedVoiceModel: { value: Schema.String },
  UpdatedBackendModel: { value: Schema.String },
  SubmittedVoiceModels: {},
  CompletedSaveSettings: { saved: Schema.Boolean },
  ClickedClose: {}
})

export const SettingsPanelEvents = UiSchema.TaggedEnum({ RequestedClose: {} })

export class SaveSettings extends Command.Service<SaveSettings>()(
  "settings/SaveSettings",
  {
    args: {
      preferSubscription: Schema.optionalKey(Schema.Boolean),
      openAiKey: Schema.optionalKey(Secret),
      voiceModel: Schema.optionalKey(Schema.String),
      voiceBackendModel: Schema.optionalKey(Schema.String)
    },
    success: SettingsPanelMessage,
    invalidates: () => [SettingsTag]
  }
) {
  static readonly layer = this.toLayer(
    Effect.gen(function*() {
      const bridge = yield* Bridge
      return ({ openAiKey, ...rest }) =>
        bridge.call("settings.update", {
          ...rest,
          ...(openAiKey === undefined ? {} : { openAiKey: Redacted.value(openAiKey) })
        }).pipe(
          Effect.match({
            onSuccess: () => SettingsPanelMessage.CompletedSaveSettings({ saved: true }),
            onFailure: () => SettingsPanelMessage.CompletedSaveSettings({ saved: false })
          })
        )
    })
  )
}

/** Picks the default folder for new threads and saves it in one step. */
export class PickDefaultFolder extends Command.Service<PickDefaultFolder>()(
  "settings/PickDefaultFolder",
  { success: SettingsPanelMessage, invalidates: () => [SettingsTag] }
) {
  static readonly layer = this.toLayer(
    Effect.gen(function*() {
      const bridge = yield* Bridge
      return () =>
        Effect.gen(function*() {
          const path = yield* bridge.call("dialog.pickFolder", undefined)
          if (path !== null) yield* bridge.call("settings.update", { defaultCwd: path })
          return SettingsPanelMessage.CompletedSaveSettings({ saved: path !== null })
        }).pipe(Effect.catch(() => Effect.succeed(SettingsPanelMessage.CompletedSaveSettings({ saved: false }))))
    })
  )
}

const accountLine = (account: Account | null) => {
  if (account === null || account.state === "unknown") return "Checking which Claude account is signed in"
  if (account.state === "signedOut") return "Not signed in. Run `claude` in a terminal and use /login."
  const how = account.state === "subscription" ? "Claude subscription" : "API key"
  return account.detail === "" ? how : `${how} · ${account.detail}`
}

export const SettingsPanelNoDeps = Html.component({
  name: "SettingsPanel",
  props: Schema.Struct({ account: Schema.NullOr(Account) }),
  model: Schema.Struct({
    key: Secret,
    voiceModel: Schema.NullOr(Schema.String),
    backendModel: Schema.NullOr(Schema.String),
    notice: Schema.String
  }),
  message: SettingsPanelMessage,
  events: SettingsPanelEvents,
  queries: { settings: { query: GetSettings, args: () => ({}) } }
}).make({
  init: () => ({ key: Redacted.make(""), voiceModel: null, backendModel: null, notice: "" }),
  update: {
    UpdatedKey: ($, { value }) => $.evolve({ key: value, notice: "" }),
    SubmittedKey: ($) =>
      Redacted.value($.model.key).trim() === ""
        ? $.model
        : $.evolve({ key: Redacted.make("") }).run(SaveSettings.make({ openAiKey: $.model.key })),
    ClickedClearKey: ($) => $.run(SaveSettings.make({ openAiKey: Redacted.make("") })),
    ToggledSubscription: ($, { checked }) => $.run(SaveSettings.make({ preferSubscription: checked })),
    ClickedFolder: ($) => $.run(PickDefaultFolder.make()),
    UpdatedVoiceModel: ($, { value }) => $.evolve({ voiceModel: value, notice: "" }),
    UpdatedBackendModel: ($, { value }) => $.evolve({ backendModel: value, notice: "" }),
    SubmittedVoiceModels: ($) =>
      $.run(
        SaveSettings.make({
          ...($.model.voiceModel === null ? {} : { voiceModel: $.model.voiceModel.trim() }),
          ...($.model.backendModel === null ? {} : { voiceBackendModel: $.model.backendModel.trim() })
        })
      ),
    CompletedSaveSettings: ($, { saved }) =>
      $.evolve({ notice: saved ? "Saved" : "", voiceModel: null, backendModel: null }),
    ClickedClose: ($) => $.emit(SettingsPanelEvents.RequestedClose())
  },
  view: (h, model) =>
    h.section.class("panel settings").attr("aria-label", "Settings").children(
      h.header.class("panel-head").children(
        h.div.class("panel-title").children(h.h2("Settings")),
        h.div.class("panel-actions").children(
          model.notice !== "" && h.span.class("saved").attr("role", "status").children(model.notice),
          h.button.class("icon-btn").attrs({ type: "button", title: "Close", "aria-label": "Close settings" })
            .on("click", SettingsPanelMessage.ClickedClose()).children(Icon(h, "close"))
        )
      ),
      AsyncResult.match(h.queries.settings, {
        onInitial: () => h.div.class("empty").children("Loading settings"),
        onFailure: () => h.div.class("empty").children("Settings could not be loaded."),
        onSuccess: ({ value: settings }) =>
          h.div.class("settings-body").children(
            h.section.class("setting-group").children(
              h.h3("Claude"),
              h.p.class("setting-status").children(Icon(h, "spark"), accountLine(h.props.account)),
              h.label.class("toggle").children(
                h.input.attr("type", "checkbox").checked(settings.preferSubscription)
                  .on("change", ({ checked }) => SettingsPanelMessage.ToggledSubscription({ checked })),
                h.span(
                  h.strong("Use my Claude login"),
                  h.span.class("muted").children(
                    "Agents sign in the way the claude CLI does and ignore ANTHROPIC_API_KEY. Applies to the next message."
                  )
                )
              ),
              h.div.class("setting-row").children(
                h.div(
                  h.strong("Default folder"),
                  h.span.class("muted mono").children(settings.defaultCwd)
                ),
                h.button.class("btn").attr("type", "button").on("click", SettingsPanelMessage.ClickedFolder())
                  .children(Icon(h, "folder"), "Change")
              )
            ),
            h.section.class("setting-group").children(
              h.h3("Live voice"),
              h.p.class("setting-status").children(
                Icon(h, "mic"),
                settings.hasOpenAiKey ? "OpenAI key stored in your keychain" : "Add an OpenAI API key to talk to the board"
              ),
              h.form.class("setting-form").on("submit", SettingsPanelMessage.SubmittedKey()).children(
                h.input.attrs({
                  type: "password",
                  "aria-label": "OpenAI API key",
                  placeholder: settings.hasOpenAiKey ? "Replace key" : "sk-…",
                  autocomplete: "off",
                  spellcheck: "false"
                }).value(Redacted.value(model.key))
                  .on("input", ({ value }) => SettingsPanelMessage.UpdatedKey({ value: Redacted.make(value) })),
                h.button.class("btn primary").attr("type", "submit")
                  .disabled(Redacted.value(model.key).trim() === "").children("Save key"),
                settings.hasOpenAiKey &&
                  h.button.class("btn ghost").attr("type", "button")
                    .on("click", SettingsPanelMessage.ClickedClearKey()).children("Remove")
              ),
              h.form.class("setting-form").on("submit", SettingsPanelMessage.SubmittedVoiceModels()).children(
                h.label.class("field").children(
                  h.span("Voice model"),
                  h.input.attrs({ type: "text", spellcheck: "false" })
                    .value(model.voiceModel ?? settings.voiceModel)
                    .on("input", ({ value }) => SettingsPanelMessage.UpdatedVoiceModel({ value }))
                ),
                h.label.class("field").children(
                  h.span("Reasoning model"),
                  h.input.attrs({ type: "text", spellcheck: "false" })
                    .value(model.backendModel ?? settings.voiceBackendModel)
                    .on("input", ({ value }) => SettingsPanelMessage.UpdatedBackendModel({ value }))
                ),
                h.button.class("btn").attr("type", "submit")
                  .disabled(model.voiceModel === null && model.backendModel === null).children("Save models")
              )
            ),
            h.p.class("muted fine").children(
              "Threads, settings and transcripts are stored on this Mac. Only the agents and live voice talk to the network."
            )
          )
      })
    )
})

export const SettingsPanel = SettingsPanelNoDeps.pipe(
  Component.provide([
    Layer.mergeAll(SaveSettings.layer, PickDefaultFolder.layer).pipe(Layer.provide(Bridge.layer)),
    GetSettings.layer
  ])
)
