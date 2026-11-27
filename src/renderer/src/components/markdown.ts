import { type Html, Markdown, MarkdownParser } from "@effect/ui/html"

const cache = new Map<string, Markdown.Document | null>()
const LIMIT = 400

const parse = (text: string): Markdown.Document | null => {
  const hit = cache.get(text)
  if (hit !== undefined) return hit
  let document: Markdown.Document | null
  try {
    document = MarkdownParser.parseMarkdown(text)
  } catch {
    document = null
  }
  if (cache.size >= LIMIT) cache.clear()
  cache.set(text, document)
  return document
}

/** An agent's reply as formatted prose, or as plain text if it does not parse. */
export const Prose = <M>(h: Html.H<M>, text: string) => {
  const document = parse(text)
  return document === null
    ? h.div.class("prose plain").children(text)
    : Markdown.view(h, document).class("prose")
}
