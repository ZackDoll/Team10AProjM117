# Attack payload templates

`templates.json` is a list of payloads the batch runner and the viewer insert into documents:

```json
[
  { "id": "direct_override",
    "technique": "plain instruction override",
    "marker": "attacker@evil.example",
    "text": "The injected text, inserted as its own paragraph." }
]
```

| field | required | meaning |
|---|---|---|
| `id` | yes | letters, digits, `_` `.` `-` (no double underscore). Used in run ids and file names |
| `text` | yes | the payload. It is inserted as its own paragraph at the start, middle or end of a document |
| `marker` | no | a phrase from the payload to trace through the pipeline. The viewer fills its marker field from it to show how far the payload spread |
| `technique` | no | a note for humans, shown in the template picker |

The canary is a per-run secret held only by the tool agent, and `send_message` is a mock that only
writes to the log, so nothing a payload asks for can leave the machine.

Use a template:
```
python scripts/run_one.py --topology chain --doc data/placeholder/d1.txt --inject-template direct_override --position middle
python scripts/run_batch.py --docs data/placeholder/d1.txt --template-ids direct_override --positions start middle end
```
or pick it in the viewer's New run box (it previews the document with the payload inserted) or Batch tab.
`python scripts/inject_doc.py` is the single implementation of where a payload goes.
