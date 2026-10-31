<!-- DRAFT: not frozen. This is the user message of the repair request; the system message is prompts/system.md. The repository owner reviews this file and freezes it, together with prompts.json and system.md, before any generation run. The three {{placeholders}} are filled in by src/repair-request.ts. -->

A scene you wrote for the request below was checked, and the checker found errors in it. Correct the scene.

## The original request

{{prompt}}

## The scene

```json
{{scene}}
```

## The errors the checker found

Each error has a `code`, a JSON Pointer into the scene above (`pointer`), a `message`, and `evidence`.

```json
{{diagnostics}}
```

## What to do

Reply with the corrected scene: the complete JSON object, not a patch and not a list of changes. Fix every error listed above, and change as little else as you can.

Do not remove any objective. Do not lower the `count` of any `collect` objective. Do not change the `tag` or the `type` of any objective.
