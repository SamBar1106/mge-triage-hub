/*
 * CSV builders. Header lists/orders are copied verbatim from the original scrapers
 * (Scrapers_fixtures/) and from data/clients_directory.csv so the web app's parser
 * (js/app.js parseCSV, header-name lookup) keeps working unchanged.
 * Rules: every field quoted, "" escaping, CR/LF inside values -> space, CRLF line
 * endings, trailing newline (prevents the "glued rows" seam), UTF-8 BOM like the originals.
 */
(function (root) {
  'use strict';

  // Subset of clients_directory.csv headers that the Active Client List page reliably provides.
  const CLIENT_HEADERS = [
    'Client ID', 'Doctor Name', 'Consultant', 'Account Status', 'Doctor Email',
    'Work Phone', 'Default Address', 'Client URL', 'Dashboard URL'
  ];

  const PDF_HEADERS = [
    'Document Title', 'Generator Suitelet', 'Signee Contact ID', 'Signee Name in File', 'Contact Full Name', 'Role / Position', 'Client Internal ID', 'Client Customer ID',
    'Consultant', 'Email', 'Cell Phone', 'Office Phone', 'Location', 'Services', 'Month / Dates', 'Hours / Days', 'Classroom Record Source', 'Event Record Source',
    'Requires Client Initials', 'Requires Witness Initials', 'Requires Date', 'Has Valid Date', 'PDF Schedule URL'
  ];
  const pdfRow = (r) => [
    r.documentTitle, r.generatorSuitelet, r.contactId, r.signeeName, r.contactFullName, r.positionPost, r.clientInternalId,
    r.clientCustomerId, r.consultant, r.email, r.cellPhone, r.officePhone, r.location,
    r.services, r.monthDates, r.hoursDays, r.classroomRecord, r.eventRecord, r.requiresClientInitials,
    r.requiresWitnessInitials, r.requiresDate, r.hasValidDate, r.pdfUrl
  ];

  const ZERO_DATES_HEADERS = [
    'Client Internal ID', 'Client Customer ID', 'Doctor Name', 'Contact ID', 'Role / Position', 'Consultant', 'Schedule Status', 'Total Items Count', 'Dates Found Count', 'Dates Found List',
    'Email', 'Cell Phone', 'Office Phone', 'PDF Direct URL'
  ];
  const zeroRow = (d) => [
    d.clientInternalId, d.clientCustomerId, d.doctorName, d.contactId, d.positionPost, d.consultant, d.scheduleStatus,
    d.totalItemsCount, d.datesFoundCount, d.datesFoundList, d.email, d.cellPhone, d.officePhone, d.pdfUrl
  ];

  const BACKLOG_HEADERS = [
    'Client ID', 'Client Name', 'Email', 'Consultant', 'Item Name', 'Memo',
    'Date Purchased', 'Amount', 'Date Started', 'Date Completed', 'Completion Status'
  ];
  const backlogRow = (r) => [
    r.clientId, r.clientName, r.email, r.consultant, r.itemName, r.memo,
    r.datePurchased, r.amount, r.dateStarted, r.dateCompleted, r.completionStatus
  ];

  function cell(v) {
    const s = String(v === undefined || v === null ? '' : v).replace(/\r\n|\r|\n/g, ' ');
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function buildCsv(headers, rows) {
    const lines = [headers.map(cell).join(',')];
    for (const row of rows) {
      const arr = headers.map((_, i) => row[i]); // pad/truncate: cell count ALWAYS == header count
      lines.push(arr.map(cell).join(','));
    }
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  const api = {
    CLIENT_HEADERS, PDF_HEADERS, ZERO_DATES_HEADERS, BACKLOG_HEADERS, cell, buildCsv,
    clientsCsv: (rows) => buildCsv(CLIENT_HEADERS, rows),
    pdfCsv: (items) => buildCsv(PDF_HEADERS, items.map(pdfRow)),
    zeroDatesCsv: (summaries) => buildCsv(ZERO_DATES_HEADERS,
      summaries.filter((d) => d.scheduleStatus !== 'HAS SCHEDULED DATES').map(zeroRow)),
    backlogCsv: (rows) => buildCsv(BACKLOG_HEADERS, rows.map(backlogRow))
  };
  root.MGECsv = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
