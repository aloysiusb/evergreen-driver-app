// routeParser.js
// Converts the raw 2D array from a route-day tab into a clean list of
// "stop" and "section header" objects for the API, applying the field
// whitelist from config.js so nothing unexpected ever leaks through.

import { ALLOWED_STOP_FIELDS } from "./config.js";

function pick(obj, allowedFields) {
  const out = {};
  for (const key of allowedFields) {
    if (key in obj) out[key] = obj[key];
  }
  return out;
}

function isSectionHeaderRow(row, cols) {
  const yay = row[cols.yay];
  const accountName = row[cols.accountName];
  return !yay && !(accountName && accountName.trim().length > 0);
}

// A date row looks like "06.23.2026 - TUES DV" - also a section-header
// shaped row, but we tag it separately so the UI can show it as the
// page title instead of a normal section banner.
function isDateRow(row, label) {
  return /\d{1,2}\.\d{1,2}\.\d{2,4}/.test(label || "");
}

/**
 * @param {string[][]} rawRows - raw values from the sheet, including header row
 * @returns {{ items: object[], routeDate: string|null, headerRowOffset: number }}
 */
export function parseRouteTab(rawRows) {
  if (!rawRows || rawRows.length === 0) {
    return { items: [], routeDate: null };
  }

  // Find the real header row (contains "Address" and "Account Name")
  // rather than assuming it's always row 0 - guards against stray blank
  // leading rows from manual edits or copy/paste in the sheet.
  // Support both plain string[][] (legacy/backup) and { values, rowColor }[] (with colors)
  const normalized = rawRows.map(r =>
    Array.isArray(r) ? { values: r, rowColor: null } : r
  );

  const headerIdx = normalized.findIndex(
    ({ values: row }) => row.includes("Address") && row.includes("Account Name")
  );

  // Detect column positions from the header row so tabs with/without the
  // legacy "Ney" column both work correctly.
  const headerRow = headerIdx >= 0 ? normalized[headerIdx].values : [];
  const fi = (name) => headerRow.findIndex(h => h && h.trim().toLowerCase() === name.toLowerCase());
  const cols = {
    yay:         fi("Yay"),
    address:     fi("Address"),
    notes:       fi("Driver Notes and Special Requests") !== -1
                   ? fi("Driver Notes and Special Requests")
                   : fi("Notes"),
    directions:  fi("Directions"),
    accountName: fi("Account Name"),
    city:        fi("City"),
  };

  const dataRows = normalized.slice(headerIdx >= 0 ? headerIdx + 1 : 1);
  const rowOffset = headerIdx >= 0 ? headerIdx + 1 : 1;
  const items = [];
  let routeDate = null;
  let currentSection = null;

  dataRows.forEach(({ values: row, rowColor }, idx) => {
    const sheetRowNumber = idx + rowOffset + 1;

    if (isSectionHeaderRow(row, cols)) {
      const label = (row[cols.address] || "").trim();
      if (!label) return;

      if (isDateRow(row, label)) {
        routeDate = label;
        return;
      }

      currentSection = label;
      items.push(
        pick(
          {
            rowNumber: sheetRowNumber,
            isSectionHeader: true,
            sectionLabel: label,
            rowColor: rowColor || null,
          },
          ALLOWED_STOP_FIELDS
        )
      );
      return;
    }

    const yay         = row[cols.yay]         || "";
    const address     = row[cols.address]     || "";
    const notes       = row[cols.notes]       || "";
    const directions  = row[cols.directions]  || "";
    const accountName = row[cols.accountName] || "";
    const city        = row[cols.city]        || "";

    const isFullyBlank =
      !address.trim() && !notes.trim() && !accountName.trim() && !city.trim();
    if (isFullyBlank) return;

    items.push(
      pick(
        {
          rowNumber: sheetRowNumber,
          isSectionHeader: false,
          done: String(yay).toUpperCase() === "TRUE",
          address: address.trim(),
          notes: notes.trim(),
          directions: directions.trim(),
          accountName: accountName.trim(),
          city: city.trim(),
          sectionLabel: currentSection,
          rowColor: rowColor || null,
        },
        ALLOWED_STOP_FIELDS
      )
    );
  });

  return { items, routeDate };
}

// Classifies a note's urgency for UI coloring. Kept simple and
// keyword-based so the office can extend it without touching the parser.
const URGENT_KEYWORDS = ["get ", "eow", "asap", "today", "now"];
const HOLD_KEYWORDS = ["skip", "hold", "on hold", "cancel"];

export function classifyNote(noteText) {
  if (!noteText) return null;
  const lower = noteText.toLowerCase();
  if (HOLD_KEYWORDS.some((k) => lower.includes(k))) return "hold";
  if (URGENT_KEYWORDS.some((k) => lower.includes(k))) return "urgent";
  return "info";
}
