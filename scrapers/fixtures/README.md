# scrapers/fixtures — local only

This folder holds **saved NetSuite pages** that are used to test the scrapers offline, for example:

- `active-client-list.html` (or `Active Client List.html`): the "Active Client List" saved-search results page (`searchresults.nl?searchid=72`)
- `dashboard.html` (or `Dash board .html`): a client dashboard (`card.nl?sc=-69&entityid=…`) with the "Paid Uncompleted Items" portlet
- `Contact Page.html`, `Client page Net Suite .html`: optional reference pages

**These files contain real client data and NetSuite session tokens (`_csrf`), so they must never be committed.**
`.gitignore` blocks `scrapers/fixtures/*.html`. Only this README is tracked.

To save a page: open it in Chrome while logged in to NetSuite, press **Ctrl+S**, pick "Webpage, Complete" (or "HTML only"), and save it into this folder.
Then run the offline tests:

```
cd tests && npm install && npm test
```

If a fixture is missing, its test is reported as SKIP. The synthetic tests still run.
