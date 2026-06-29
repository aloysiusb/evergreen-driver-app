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

// A "section header" row in this sheet has its label sitting in the
// Address column position (D), but no checkbox values and no Account
// Name (G). E.g. "INDUSTRIAL DOLORES and SATANK" or "USE HALLEY'S COMET"
// both appear in column D with everything else on the row blank.
function isSectionHeaderRow(row) {
  const [, ney, yay, , , , accountName] = row;
  const hasCheckboxData = ney || yay;
  const hasAccountName = accountName && accountName.trim().length > 0;
  return !hasCheckboxData && !hasAccountName;
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
  const headerIdx = rawRows.findIndex(
    (row) => row.includes("Address") && row.includes("Account Name")
  );
  const dataRows = rawRows.slice(headerIdx >= 0 ? headerIdx + 1 : 1);
  const rowOffset = headerIdx >= 0 ? headerIdx + 1 : 1; // rows before first data row
  const items = [];
  let routeDate = null;
  let currentSection = null;

  dataRows.forEach((row, idx) => {
    const sheetRowNumber = idx + rowOffset + 1; // 1-indexed sheet row

    if (isSectionHeaderRow(row)) {
      const label = (row[3] || "").trim();
      if (!label) return; // fully blank row, skip

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
          },
          ALLOWED_STOP_FIELDS
        )
      );
      return;
    }

    // Normal stop row.
    const [, , yay, address, notes, directions, accountName, city] = row;

    const isFullyBlank =
      !address?.trim() && !notes?.trim() && !accountName?.trim() && !city?.trim();
    if (isFullyBlank) return; // trailing/empty row in the sheet, skip it

    items.push(
      pick(
        {
          rowNumber: sheetRowNumber,
          isSectionHeader: false,
          done: String(yay).toUpperCase() === "TRUE",
          address: (address || "").trim(),
          notes: (notes || "").trim(),
          directions: (directions || "").trim(),
          accountName: (accountName || "").trim(),
          city: (city || "").trim(),
          sectionLabel: currentSection,
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
