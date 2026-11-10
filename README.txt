FIELD ROUTES API - go-between for the Field routes app and GoHighLevel
It holds the GoHighLevel key so the public app never sees it. No dependencies.

RENDER SETUP (New > Web Service, pick this repo)
  Runtime:        Node
  Build command:  npm install
  Start command:  node server.js
  Instance:       Free works. It sleeps when unused, so the first sync of the day
                  can take up to a minute. A paid instance stays awake.

ENVIRONMENT VARIABLES (Render > the service > Environment)
  GHL_TOKEN        Private Integration key of the sub-account (starts with pit-)
  GHL_LOCATION_ID  Sub-account Location ID
  APP_KEY          A password you invent. Type the same one in the app,
                   Reports > GoHighLevel > App password.
  ALLOWED_ORIGIN   Address of the app, for example https://field-routes-xxxx.onrender.com
                   (optional; without it any site can call the service, but only with APP_KEY)
  PIPELINE_NAME    Optional. Pipeline that receives orders. Default: Commandes
  GHL_VERSION      Optional. API version header. Default: 2021-07-28

PRIVATE INTEGRATION ACCESS NEEDED
  View and edit contacts, view and edit opportunities, view and edit custom fields
  (locations), upload media (medias).

WHAT IT CREATES IN GOHIGHLEVEL
  - 3 contact custom fields on first use: Field routes ID, Store number, Region.
  - One contact per store, the first time a note or order is sent for it,
    tagged field-routes and the list name. If a contact with the same email or
    phone already exists, that contact is reused.
  - Visit notes on the contact, photos in the Media library, links in the note.
  - Orders: a note with the lines and total, the Excel in the Media library,
    and an opportunity (status won, value = total) in the first stage of the
    "Commandes" pipeline. Create that pipeline yourself; without it the order
    note is still written.

CHECK
  https://<service>.onrender.com/health  shows ready: true when all 3 required
  variables are set. The app's "Connect and test" button checks the key, the
  custom fields and the pipeline.
