# New York work order router

A Vercel compatible dispatcher app for **one or more bulk PDFs with one work order per page**, using the form shown in the sample. Select files together or add them one at a time. It extracts labeled fields locally in the browser, checks addresses with the U.S. Census geocoder, groups and orders jobs, then makes one original-page PDF packet per installer. Each packet can be downloaded or sent to a configured Power Automate flow. There is no database or permanent PDF storage.

## What works

- Multiple bulk PDF upload and editable WO number, street, city, state, ZIP fields; malformed and duplicate work-order numbers across files block routing. Further file selections append to the batch. Files can be removed individually; adding or removing resets address review and routes. Once any route has been emailed, start a new batch to select files again.
- Dispatchers can correct a field in the review table and recheck just that address without repeating the entire batch lookup.
- Blank pages are skipped while each order retains its source filename and original page number. The provided sample contains 10 work orders and a blank 11th page. Packets copy the original pages from the appropriate input PDF in the route's reviewed order.
- Address checks through the public Census batch geocoder. Unit/floor stays on the original page but is removed from the lookup address.
- Unmatched addresses stay in the work list. Dispatch can correct and recheck them, explicitly use an approximate ZIP-area location, or enter a verified latitude/longitude pin. The ZIP area comes from exact matches in the same ZIP or a bundled offline NY centroid (BSD notice in `licenses/zipcodes-BSD.txt`). Wide ZIPs can place a stop far from its actual service address, so the assignment and directions need human review.
- Every uploaded order goes to exactly one route. Dispatch can change installer assignment and stop order on the route screen. Approximate or manual locations require an explicit review checkbox before the app enables email. The packet marks those locations and keeps the original work order pages intact.
- The usual 14–16 job limits apply at route build; the pilot override permits shorter initial routes. Manual reassignment can leave a route below 14 but cannot exceed 16. After an edit, the travel estimate clears because it no longer reflects the chosen order.
- Approximate distance clustering and stop ordering with an optional privately operated OSRM driving-time matrix. This is a heuristic, **not a global optimum**. Without OSRM, the displayed travel estimate is based on straight-line distance at 25 km/h, not actual road travel.
- Per-installer packet PDFs, assembled from **only that route's original pages** in suggested stop order. The PDF is not uploaded to Vercel until a dispatcher deliberately emails the packet.
- Every packet starts with a route sheet showing the reviewed addresses. Dispatcher edits are flagged **CORRECTED**; approximate locations show **REVIEWED** or **NOT REVIEWED**. Original signed work-order pages are preserved behind it.
- Per-installer email via Power Automate after dispatcher review. Failed or uncertain responses are not silently marked sent.

## Local setup

Requires Node 20.19+ or 22.12+ (Node 24 also works).

```bash
npm install
cp .env.example .env.local
npm run dev
```

Vite's dev server does not execute the Vercel `/api` functions. Use `vercel dev` with your Vercel account for local address matching and email, or deploy the repository to Vercel. `npm run build` and `npm test` validate the client.

## Vercel setup

1. Import this repository as a new Vercel project. Framework preset **Vite**; build command `npm run build`; output directory `dist`.
2. For the free prototype (PDF parsing, Census address matching, approximate routing, and packet downloads), no password or API key is required. For email or optional private road routing, configure `DISPATCH_PASSWORD` to a long random string. Keep it private; dispatchers enter it on the page, and the browser retains it only in memory. Email and road-routing endpoints reject requests when this variable is missing.
3. For email, set `POWER_AUTOMATE_URL` to an HTTP trigger URL and `ALLOWED_EMAIL_DOMAIN` to the company domain, without `@`. An HTTP request trigger may require a Power Automate Premium license. Do not expose its trigger URL in client-side code.
4. Optional: `OSRM_URL` for a private OSRM compatible `/table/v1/driving` service. The public OSRM demo is not intended as the production backend for hundreds of customer addresses. If unset, select **Free approximate distance**.
5. Restrict Vercel project access to dispatchers through your company's approved identity controls before using real customer addresses. The prototype address-matching endpoint is unauthenticated; a shared secret on email and road-routing endpoints is not a full user login or audit system.

The browser uploads **only street, city, state, ZIP, and page number** to `/api/geocode`; that endpoint forwards those addresses to the U.S. Census service. Private routing sends coordinates to the configured OSRM endpoint. The email endpoint forwards each assigned PDF to Power Automate. Review whether these data flows are approved by your company before entering real customer information.

## Power Automate flow

Create a cloud flow with **When an HTTP request is received**, using this sample schema:

```json
{
  "type": "object",
  "required": ["email", "filename", "contentBase64", "subject", "body", "dispatchId", "orderIds"],
  "properties": {
    "email": { "type": "string" },
    "filename": { "type": "string" },
    "contentBase64": { "type": "string" },
    "subject": { "type": "string" },
    "body": { "type": "string" },
    "dispatchId": { "type": "string" },
    "orderIds": { "type": "array", "items": { "type": "string" } }
  }
}
```

Add **Send an email (V2)** from Office 365 Outlook. Set To = `email`, Subject = `subject`, Body = `body`, Attachment Name = `filename`, and Attachment Content = `base64ToBinary(triggerBody()?['contentBase64'])`. Check this expression in your tenant's flow designer. Add a durable duplicate check keyed on `dispatchId` before sending; a timeout can otherwise leave the app uncertain whether an email was already sent. Restrict the trigger to authenticated callers if your Power Automate environment supports it; the trigger URL remains a secret on Vercel either way. Return an HTTP success response after the email action succeeds so the app can mark the route accepted.

Each packet has a 3.5 MB base64 request cap to stay below Vercel's function payload limit. Larger packets can be downloaded and sent through an approved manual channel. The system sends **one route at a time** after dispatcher review and does not automatically retry a failed send.

## Routing assumptions

- Appointment Date is displayed but not treated as a promised appointment window. Confirm its business meaning before enforcing time windows.
- Routes are open paths: travel to the first stop, the last stop back home, service duration, traffic, shifts, and installer territories are not modeled. A route with 14–16 jobs may still be impossible in one workday.
- The route review includes Google Maps direction links in chunks. Those links are for human review and may recalculate their own travel sequence or differ from the displayed estimate.
- Address checks can fail even for real addresses. An unmatched order needs a selected planning location before routes can be built. A ZIP-area estimate or dispatch pin is a planning aid, not proof of the service address; confirm the actual destination and directions, then approve its route assignment before emailing. Downloads can include unreviewed locations and are marked **NOT REVIEWED** on the route sheet.
- Up to 500 PDF pages total across selected files; the optional OSRM matrix endpoint supports up to 200 stops per run. For larger volume or strict appointment constraints, replace the heuristic with a production vehicle routing service.

## Privacy and deployment

Do not commit actual work order PDFs, `.env.local`, customer lists, or installer credentials. The supplied customer sample is **not** part of this repository. Browser memory is cleared on tab close; no packet history is stored. To track dispatches or prevent duplicate emails, implement durable flow-side logging. Consult your internal security and privacy process before using real customer addresses with an external geocoder or sending customer documents through the configured email flow.
