/* Shared by driver.js and dispatch.html.
 *
 * Does this error mean the app has lost its Google access, rather than hitting
 * something a retry could fix? A credential or project-level failure is not
 * retryable: the button cannot work, and offering it tells the person the
 * problem is theirs.
 *
 * Kept here only. driver.js had the one copy; dispatch.html needed the same
 * judgement and copy-pasting it is how style-units.js came to exist. The two
 * screens must agree about what an outage is — the driver being told the
 * office knows, while the office's own board shows nine lines of
 * invalid_grant, is the drift this prevents. */
function isAccessFailure(msg) {
  /* SERVICE_ACCOUNT catches sheets.js's own two startup errors — the key env
     var missing, and the key not being valid JSON. Both are configuration,
     not weather, and neither was matched before: a driver would have got a
     Retry button that could never work. */
  return /invalid_grant|account not found|has been disabled|API project|SERVICE_DISABLED|PERMISSION_DENIED|API key|SERVICE_ACCOUNT|credential/i
    .test(msg);
}
