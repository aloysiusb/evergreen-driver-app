// config.js
// Central place for: which tabs are "route day" tabs, and EXACTLY which
// columns the driver app is allowed to read or write.
//
// SECURITY RULE: this is a whitelist, not a blacklist. Any column not
// listed here is invisible to the app, even if someone adds a new column
// to the sheet later (e.g. a billing field). Nothing flows through by
// default — it has to be explicitly added below.

export const ROUTE_DAY_TABS = [
  "Tues DV",
  "TUES 4WD ACTION",
  "Weds DV Res",
  "Weds Commercial",
  "Thurs UV",
  "Thursday COMEAGLE",
  "Friday",
  "Monday",
  "Max Routes",
];

// Column layout on each route-day tab, by position (A, B, C...).
// Actual sheet structure (Ney column was removed in the converted sheet):
// A: (blank) B: Yay  C: Address  D: Driver Notes & Special Instructions
// E: Driving Directions  F: Account Name  G: City
export const ROUTE_COLUMNS = {
  doneCol: "B",            // "Yay" column - the single done/not-done flag we use
  addressCol: "C",
  notesCol: "D",
  directionsCol: "E",
  accountNameCol: "F",
  cityCol: "G",
};

// Explicit allow-list of fields ever exposed to the driver app's API
// responses. Anything else in the row (e.g. future "Rate", "Billing",
// "Card", "Account #" columns) is dropped before the JSON ever leaves
// the server.
export const ALLOWED_STOP_FIELDS = [
  "rowNumber",
  "done",
  "address",
  "notes",
  "directions",
  "accountName",
  "city",
  "isSectionHeader",
  "sectionLabel",
  "rowColor",
];

// Sheets that are explicitly OFF LIMITS to the driver-facing API,
// because they contain billing/financial/internal data, even though
// they may share the same spreadsheet.
export const EXCLUDED_TABS = [
  "New Customers",      // contains "Rate/Accounting Notes" column
  "Container Circus",   // also has financial/account notes
  "Customer Movment",
  "Schedule",
  "Weeklies",
];

export const NOTES_TAB = "Driver Notes Log"; // new tab we create for free-form notes
