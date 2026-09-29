/*
 * MGE Client Bucketing & Classification Module.
 * Shared between the Chrome extension and the static web app.
 * Classifies clients into PENDING_SCHEDULE, SCHEDULE_INCOMPLETE, or PROGRAM_COMPLETE.
 */
(function (root) {
  'use strict';

  const EVENT_MAPPINGS = {
    'Conditions & Statistic Management Seminar': [
      'conditions & statistics management seminar',
      'conditions & statistic management seminar',
      'conditions & statistic management seminar - dr.',
      'conditions & statistic management seminar – om',
      'conditions & statistic management seminar: om'
    ],
    'DSO Summit': ['dso summit'],
    'Financial Planning & Profitability Seminar': [
      'financial planning & profitability seminar',
      'financial planning & profitability seminar - dr.',
      'financial planning & profitability seminar – om'
    ],
    'Get Out of Network Blueprint': ['get out of network blueprint'],
    'Management Tools & Troubleshooting Seminar': [
      'management tools & troubleshooting seminar',
      'management tools & troubleshooting seminar - dr.',
      'management tools & troubleshooting seminar – om'
    ],
    'Marketing Seminar': ['marketing seminar'],
    'New Patient Workshop': ['new patient workshop'],
    'OM Bootcamp': ['om bootcamp'],
    'Organizing Board & Teambuilding Seminar': [
      'organizing board & teambuilding seminar',
      'organizing board & teambuilding seminar - dr.',
      'organizing board & teambuilding seminar – om'
    ],
    'Owner\'s Conference': ['owner\'s conference'],
    'Sales Seminar A': ['sales seminar a', 'sales seminar a - in person only'],
    'Sales Seminar B': ['sales seminar b', 'sales seminar b - in person only'],
    'Sales Seminar C': ['sales seminar c', 'sales seminar c - in person only'],
    'Sales Team Bootcamp': ['sales team bootcamp'],
    'Scheduling for Production Seminar': ['scheduling for production seminar'],
    'The Goals & Strategic Planning Workshop': ['the goals & strategic planning workshop', 'goals & strategic planning workshop']
  };

  const EXCLUDED_ITEMS = [
    'Additional Year for All-Inclusive 3 Year Program',
    'Materials for All-Inclusive 3 Year Program',
    '3rd Year of All-Inclusive 3 Year Program',
    '2nd Year of All-Inclusive 3 Year Program',
    '1st Year of All-Inclusive 3 Year Program',
    'Extra Attendee for Owners Conference',
    'Money Left on Account',
    'Get Out of Network Blueprint',
    '5th Year of All-Inclusive 5 Year Program',
    '4th Year of All-Inclusive 5 Year Program',
    'Unlimited MGE Services Part 1',
    'Unlimited MGE Services Part 2',
    'Unlimited MGE Services Part 3',
    '4th Year of All-Inclusive 4 Year Program',
    '9th Year of All-Inclusive 10 Year Program',
    '8th Year of All-Inclusive 10 Year Program',
    '7th Year of All-Inclusive 10 Year Program',
    '6th Year of All-Inclusive 10 Year Program',
    '10th Year of All-Inclusive 10 Year Program',
    '3rd Year of All-Inclusive 4 Year Program'
  ];

  function parseCsv(text) {
    if (!text || typeof text !== 'string') return [];
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length === 0) return [];
    const parseRow = (rowText) => {
      const cells = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < rowText.length; i++) {
        const char = rowText[i];
        const nextChar = rowText[i + 1];
        if (char === '"') {
          if (inQuotes && nextChar === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (char === ',' && !inQuotes) {
          cells.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      cells.push(current.trim());
      return cells;
    };
    const headers = parseRow(lines[0]);
    const records = [];
    for (let i = 1; i < lines.length; i++) {
      const row = parseRow(lines[i]);
      if (row.length === headers.length) {
        const obj = {};
        headers.forEach((h, idx) => { obj[h] = row[idx]; });
        records.push(obj);
      }
    }
    return records;
  }

  function classifyClient(client) {
    client.pdfRecords.sort((a, b) => (b['Month / Dates'] || b.monthDates || '').localeCompare(a['Month / Dates'] || a.monthDates || ''));

    // Check if client has *any* valid dates scheduled in PDF
    const hasDates = client.pdfRecords.some((pdf) => {
      const dates = (pdf['Month / Dates'] || pdf.monthDates || '').toUpperCase().trim();
      return dates !== 'NO DATES' && dates !== 'NO DATE' && dates !== 'N/A' && dates.length > 0;
    });

    client.pdfStatus = hasDates ? 'Has Dates' : 'No Dates';

    client.backlogItems.forEach((item) => {
      item.isExpired = (item['Memo'] || item.memo || '').toUpperCase().includes('EXPIRED');
      const itemName = (item['Item Name'] || item.itemName || '').toLowerCase().trim();
      const isCompleted = (item['Completion Status'] || item.completionStatus || '').toUpperCase() === 'COMPLETED';

      const isScheduledInPdf = client.pdfRecords.some((pdf) => {
        let services = ((pdf['Location'] || pdf.location || '') + ' | ' + (pdf['Services'] || pdf.services || '') + ' | ' + (pdf['Month / Dates'] || pdf.monthDates || '') + ' | ' + (pdf['Hours / Days'] || pdf.hoursDays || '')).toLowerCase();

        // Fix NetSuite PDF export ligature corruptions
        services = services.replace(/\uFFFD/g, 'fi');
        services = services.replace(/, courseroom/g, '')
          .replace(/courseroom/g, '')
          .replace(/, online/g, '')
          .replace(/online/g, '')
          .replace(/livestream/g, '');

        const normItem = itemName.replace(/- in person only/g, '').replace(/livestream/g, '').trim();
        let matched = services.includes(normItem);

        if (!matched && typeof EVENT_MAPPINGS !== 'undefined') {
          for (const title in EVENT_MAPPINGS) {
            const variants = EVENT_MAPPINGS[title];
            if (variants.some((v) => v.includes(itemName) || itemName.includes(v))) {
              if (variants.some((v) => services.includes(v.replace(/- in person only/g, '').replace(/livestream/g, '').trim()))) {
                matched = true;
                break;
              }
            }
          }
        }

        if (matched) {
          if (itemName.includes('seminar')) {
            const hasSuffixMarker = itemName.match(/[-–:]/);
            const isDr = itemName.includes('dr.');
            const isInPerson = itemName.includes('in person');
            if (hasSuffixMarker && !isDr && !isInPerson) {
              return false;
            }
          }
          return true;
        }
        return false;
      });

      item.isScheduled = isCompleted || isScheduledInPdf;
    });

    const activePendingItems = client.backlogItems.filter((item) => !item.isScheduled && !item.isExpired);
    client.pendingItemsCount = activePendingItems.length;
    client.pendingAmount = activePendingItems.reduce((sum, item) => sum + (item.numericAmount || 0), 0);

    if (client.pendingItemsCount === 0) {
      client.bucket = 'PROGRAM_COMPLETE';
    } else if (hasDates) {
      client.bucket = 'SCHEDULE_INCOMPLETE';
    } else {
      client.bucket = 'PENDING_SCHEDULE';
    }
    client.backlogStatus = client.pendingItemsCount === 0 ? 'No Paid Items' : 'Items pending for Schedule';
    return client.bucket;
  }

  function computeBuckets(inputs) {
    inputs = inputs || {};
    let clients = inputs.clients || [];
    let pdf = inputs.pdf || [];
    let backlog = inputs.backlog || [];
    let contacts = inputs.contacts || [];

    if (typeof clients === 'string') clients = parseCsv(clients);
    if (typeof pdf === 'string') pdf = parseCsv(pdf);
    if (typeof backlog === 'string') backlog = parseCsv(backlog);
    if (typeof contacts === 'string') contacts = parseCsv(contacts);

    const clientsMap = new Map();
    clients.forEach((c) => {
      const id = String(c['Client ID'] || c.clientId || (Array.isArray(c) ? c[0] : '')).trim();
      if (!id) return;
      clientsMap.set(id, {
        clientId: id,
        doctorName: c['Doctor Name'] || c.doctorName || (Array.isArray(c) ? c[1] : ''),
        consultant: c['Consultant'] || c.consultant || (Array.isArray(c) ? c[2] : ''),
        accountStatus: c['Account Status'] || c.accountStatus || (Array.isArray(c) ? c[3] : ''),
        doctorEmail: c['Doctor Email'] || c.doctorEmail || (Array.isArray(c) ? c[4] : ''),
        workPhone: c['Work Phone'] || c.workPhone || (Array.isArray(c) ? c[5] : ''),
        defaultAddress: c['Default Address'] || c.defaultAddress || (Array.isArray(c) ? c[6] : ''),
        clientUrl: c['Client URL'] || c.clientUrl || (Array.isArray(c) ? c[7] : ''),
        dashboardUrl: c['Dashboard URL'] || c.dashboardUrl || (Array.isArray(c) ? c[8] : ''),
        contacts: [],
        pdfRecords: [],
        backlogItems: [],
        bucket: null
      });
    });

    contacts.forEach((contact) => {
      const parentId = String(contact['Parent Client ID'] || contact.parentClientId || '').trim();
      if (clientsMap.has(parentId)) {
        clientsMap.get(parentId).contacts.push(contact);
      }
    });

    pdf.forEach((p) => {
      const id = String(p['Client Internal ID'] || p.clientInternalId || '').trim();
      if (clientsMap.has(id)) {
        clientsMap.get(id).pdfRecords.push(p);
      }
    });

    backlog.forEach((item) => {
      const itemName = (item['Item Name'] || item.itemName || '').trim();
      if (EXCLUDED_ITEMS.includes(itemName)) return;
      const id = String(item['Client ID'] || item.clientId || '').trim();
      if (clientsMap.has(id)) {
        const amountStr = String(item['Amount'] || item.amount || '0');
        const numericAmount = parseFloat(amountStr.replace(/[^0-9.-]+/g, '')) || 0;
        clientsMap.get(id).backlogItems.push(Object.assign({}, item, {
          'Item Name': itemName,
          'Memo': item['Memo'] || item.memo || '',
          'Completion Status': item['Completion Status'] || item.completionStatus || '',
          numericAmount
        }));
      }
    });

    let pending = 0, incomplete = 0, complete = 0;
    clientsMap.forEach((client) => {
      classifyClient(client);
      if (client.bucket === 'PENDING_SCHEDULE') pending++;
      else if (client.bucket === 'SCHEDULE_INCOMPLETE') incomplete++;
      else if (client.bucket === 'PROGRAM_COMPLETE') complete++;
    });

    return {
      clients: clientsMap.size,
      pending,
      incomplete,
      complete,
      otherCounts: {
        contacts: contacts.length,
        pdf: pdf.length,
        backlog: backlog.length
      },
      clientsMap
    };
  }

  const api = {
    EVENT_MAPPINGS,
    EXCLUDED_ITEMS,
    parseCsv,
    classifyClient,
    computeBuckets
  };

  root.MGEBuckets = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
