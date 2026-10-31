A scene you wrote for the request below was checked, and the checker found errors in it. Correct the scene.

## The original request

{{prompt}}

## The scene

```json
{{scene}}
```

## The errors the checker found

Each error has a `code`, a JSON Pointer into the scene above (`pointer`), a `message`, and `evidence`.

Do not change an objective's target unless that target appears in an UNRESOLVED_REF diagnostic below.

```json
{{diagnostics}}
```

## What to do

Reply with the corrected scene: the complete JSON object, not a patch and not a list of changes. Fix every error listed above, and change as little else as you can.

Do not remove any objective. Do not lower the `count` of any `collect` objective. Do not change the `tag` or the `type` of any objective.
