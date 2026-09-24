declare const parsedDocument: unique symbol

// The brand admits no hand-built literal: only the document parsers in this
// package can produce one, by casting a shape they validated in full. A plain
// alias would let any caller skip the parser and feed an unvalidated document
// into feature logic.
export type ParsedDocument<
  Shape extends object,
  Token extends string,
> = Shape & { readonly [parsedDocument]: Token }

export function newParsedDocument<Shape extends object, Token extends string>(
  validatedShape: Shape,
): ParsedDocument<Shape, Token> {
  return validatedShape as ParsedDocument<Shape, Token>
}
