# Grounding method

1. **Retrieval**: the question is embedded and matched against unit embeddings (cosine) combined with keyword search; results are limited to the learner's ready sources.
2. **Structured generation**: the model must return `{answerable, answer, citationUnitIds}` using only supplied units. If it cannot support an answer it sets `answerable=false`.
3. **Server-side enforcement**: cited ids are intersected with the units actually retrieved; an answer with no valid citation is treated as unsupported and replaced with a refusal. Unsupported replies are stored without citations, so the UI shows a "Not covered in your course material" banner.
4. **Citations open the source**: each citation carries the unit's locator. The viewer shows the rendered page/slide image, the video seeked to the timestamp (or a YouTube embed at that second), the extracted text, figure content, and a link to the original file.
5. **Outside knowledge is separated**: on a refusal the learner may request a general explanation. It comes from a separate endpoint with a fixed disclaimer and is rendered in a visually distinct, dashed "not source-backed" block.
6. **Quiz grounding**: questions are generated only from selected units, every question stores its source units, and feedback cites them.

Known limits: the support check is model-based, so rare false supports are possible; evaluation (`eval/`) measures citation accuracy and refusal accuracy on a labeled test set.
