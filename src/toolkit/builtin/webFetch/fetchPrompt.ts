// Texts of the WebFetch tool that the model reads. They are part of the
// model-visible behaviour: change them only together with their tests.

export const PAGE_READ_TOOL_ID = 'WebFetch'

/**
 * The user message for the fast-model extraction call: preapproved hosts get a
 * concise brief, other domains guard rails. Byte-stable: the `---` fences are the
 * content/instruction boundary.
 */
export function pageQuestionBrief(
  pageText: string,
  prompt: string,
  trustedSource: boolean,
): string {
  const guidelines = trustedSource
    ? `Answer briefly from the page content above, quoting the details, code samples and documentation passages that matter.`
    : `Answer briefly and only from the page content above. Rules:
 - A quotation from the page may not exceed 125 characters; open-source code may be reproduced where its licence allows.
 - Put every verbatim passage in quotation marks; the rest of the answer must be in your own words, not the page's.
 - Do not comment on the legality of this request or of your answer; you are not a lawyer.
 - Song lyrics are never reproduced, in whole or in part.`

  return `
Web page content:
---
${pageText}
---

${prompt}

${guidelines}
`
}
