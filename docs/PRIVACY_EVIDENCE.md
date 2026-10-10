# Privacy evidence (Step 4 of the surface upgrade)

Every sentence of the page's privacy band ("What happens to your data" on Today), the code or document that backs it, and
the test that keeps it true. Checked on 2026-10-10 against the repository at the Step 4 commit. File:line numbers are for
the frozen engine, infrastructure and docs; the page is cited by function name because its line numbers move.

| The band says | Evidence | Kept true by |
|---|---|---|
| **No accounts: your plant's private link is the only key.** | The plant id is `uuid.uuid4().hex`, 122 random bits (`app/main.py:149`, in `create_site`, `:140`). No route checks a user, a token or a password anywhere in `app/*.py`. `CLAUDE.md` puts multi-user auth out of scope. Anyone holding the id can read and change the plant, which is why the page says to keep the link private. | `e2e/flow.spec.js` (the link opens the same plant in a fresh browser context) |
| **Photos are shrunk on your phone, which drops their location data.** | `photoToJpegBase64` in `app/index.html` draws the picture on a canvas (longest side at most 1600 px) and re-encodes it as a JPEG at quality 0.85. `canvas.toBlob` writes a new file; it does not copy EXIF, GPS or XMP from the source. | `e2e/surface.spec.js`: a JPEG made in the browser and given a real EXIF block with GPS coordinates goes through the page's function, and the bytes that come out carry no APP1 segment, no `Exif`, no XMP namespace, no TIFF header and none of the coordinate bytes; the same is checked on the request the page sends. The check fails when the function is replaced by a pass-through (mutation-checked). |
| **Google Gemini reads them under Google's own terms.** | `app/extract.py:44` (`extract`) sends the image to the Gemini API (`MODEL_ID`) with the key from the environment or SSM (`app/config.py:15-35`). The terms that apply are Google's; this project makes no claim about them. | `e2e/audit.spec.js` (photo note) |
| **Surya Audit does not keep them.** | The extract route returns the candidate values with `"saved": False` (`app/main.py:186`) and never writes the image; the store keeps one item per site, `{id, version, doc}` (`app/store.py:42-64`), and the document holds the plant and its readings, not photos. `app/extract.py:4`: "never logged or stored". The 4 MB cap (`app/main.py:67`) bounds what arrives. | `tests/test_loop.py` (extract route) |
| **Readings and plant details are stored in AWS, in DynamoDB, which encrypts them at rest by default.** | `template.yaml:32-41`: one `AWS::DynamoDB::Table`, `PAY_PER_REQUEST`, no `SSESpecification`, so the default applies. AWS documentation (retrieved 2026-10-10, https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/EncryptionAtRest.html): "All user data stored in Amazon DynamoDB is fully encrypted at rest." and, for the key types, "AWS owned key - Default encryption type." | `e2e/privacy.spec.js` (the sentence) |
| **...in AWS Mumbai (ap-south-1)** (only when the page is served from an API Gateway host) | The region is set by the deploy command: `README.md:72`, `sam deploy ... --region ap-south-1`, and the deploy output kept in `.claude/deploy.local.log` (not committed) reads `Stack name: surya-audit`, `Region: ap-south-1`. There is no `samconfig.toml`. `template.yaml` itself is region-neutral, so the page does not assume a region: it reads it from the host name `*.execute-api.<region>.amazonaws.com` (`regionLabelFor`), which the deployment fixes, and states none for a local run or any other host. | `e2e/privacy.spec.js`: the host names `ap-south-1`, `eu-west-2`, `127.0.0.1`, `example.com` and an impostor suffix give the right label or none; a stand-in host answered by the test's own server shows "AWS Mumbai (ap-south-1)" in English, Hindi and Punjabi |
| **The plant's location goes to NASA POWER (weather) and, with its size, tilt, direction and loss, to PVGIS (expected output). It is rounded to about 1 km if it comes from your phone, and used as typed otherwise.** | The server passes the stored coordinates on unchanged: PVGIS gets `lat`, `lon`, `peakpower`, `loss`, `angle`, `aspect`, `outputformat` (`app/expected.py:71-74`); NASA POWER gets `latitude`, `longitude` and the dates or climatology request (`:89-91`, `:105-108`). The calls are made by the Lambda, not by the browser. "Use my location" rounds to two decimals (about 1 km) in the page (`$('locate')` handler) before the form is filled; coordinates the owner types are sent as typed. | `tests/test_surface.py` (the parameters, with five-decimal coordinates, exactly as stored, and nothing else); `e2e/flow.spec.js` (26.8467, 80.9462 becomes 26.85, 80.95) |
| **Nothing is sent for you: a complaint draft is yours to copy and file.** | `app/complaint.py:109` returns `"auto_sent": False`; the draft carries `<<OWNER TO FILL: ...>>` placeholders (`:19-45`). The page's WhatsApp link only opens a message for the owner to send (`whatsappHref`); "Copy text" and "Download evidence" are local. | `e2e/audit.spec.js` (draft, WhatsApp link, "Nothing has been sent") |
| **Forget this plant on this device: clears this browser only. Readings stay saved on the server; the plant's link still opens them.** | The `$('forget')` handler removes `surya-audit-site` (the remembered plant) and `surya-audit-assumptions` from `localStorage` and shows the setup screen. It makes no request: the DynamoDB item is untouched. The language and bigger-text choices are not plant data and stay. | `e2e/privacy.spec.js` (dismiss changes nothing; accept clears both keys; the server still returns the 60 readings; the link opens the plant again) |

## What Lambda logs

The application's own log calls write three things, none of them owner data (Lambda's runtime and an uncaught exception also write to the log; see below):

- A failed photo read (`app/main.py:180`, `describe_failure` at `:45`): the class names along the cause chain; for a Gemini
  API error Google's own code, status and message, capped at 200 characters with anything shaped like a Google API key
  cut out; for an output-validation error only the field locations and error types, never the values. Never the image, the
  text read from it, or the key. Test: `tests/test_loop.py:479`.
- A Gemini key parameter that cannot be read (`app/config.py:29-33`): the error code or class name only.
- The daily refresh (`app/refresh.py:41`): two counts.

`template.yaml` defines no API Gateway access log and no request logging. An uncaught exception is written to the log by the Lambda runtime as a traceback; the code reads no request body, key or image into a log line, and the one test above guards the photo path. Lambda's Python runtime itself writes a START,
END and REPORT line per invocation (request id, duration, memory; AWS documentation, retrieved 2026-10-10,
https://docs.aws.amazon.com/lambda/latest/dg/python-logging.html: "The Python runtime logs the `START`, `END`, and `REPORT`
lines for each invocation.").

## What is stored, and what is not

One DynamoDB item per plant (`app/store.py:42-64`): its location, size, tilt, direction, system loss, the readings (date,
kWh, period, the expected output and the weather used), the suggestions and their approvals. A complaint draft is
generated when asked and not stored. Photos are never stored. The Gemini key is in SSM Parameter Store as a SecureString
(`template.yaml:58-70`).

## Not provided

- Deletion of a plant's data from the server. The page can only forget it in this browser. A delete route is proposed in
  `NEXT_BACKEND.md`; the routes are frozen.
- Accounts, sign-in, per-owner access control: the link is the key.
- Any claim about what Google, NASA or the PVGIS service do with the requests they receive.
