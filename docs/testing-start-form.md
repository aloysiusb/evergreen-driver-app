# Testing the customer sign-up path (`/start`) end to end

A checklist for the first real run of the customer automation: a customer fills
in the form, the request reaches Approvals, it is approved, and a row lands on
the route sheet.

This is a living reference: edit it in place if the steps change.

Last reviewed: 2026-10-04.

---

## Why this test matters

Every step was tested on a running server **except the last one**. Writing the
approved customer onto the route sheet needs the live Google service-account
key, and that key exists only on Render. **Your first test is the first time that
step has ever run.** Check the sheet afterwards. Don't assume the write worked.

## Before you start

- [ ] **If you have rotated the service-account key, paste the new one into
      Render first** (Render → the service → Environment →
      `GOOGLE_SERVICE_ACCOUNT_KEY`). Otherwise the sheet write will fail.
- [ ] Have the route spreadsheet open in another tab.
- [ ] Have your email open. The "new request" email comes to **your** address.

## The test

1. **Open the form.** Go to the app's Render address with `/start` on the end.
2. **Submit a made-up customer.** Use an obviously fake name such as
   `TEST — delete me` so the row is easy to find and remove later. Use a real
   street address in the service area.
3. **Check that the screen confirms the request was sent.**
4. **Check your email** for the new-request notification. Allow a minute or two.
   - If nothing arrives, check spam. Then check the **Approvals** page: if the
     request is there, the form worked and only the email failed. See
     "If the email doesn't arrive" below.
5. **Open Approvals.** The test request should be listed as pending with every
   field you typed.
6. **Approve it.**
7. **Check the route sheet** for the new row. **This is the step that has never
   run before.**
8. **Delete the test row** from the sheet so drivers don't see it.

If steps 3, 4, 5 and 7 all worked, the path is working and the client can try it.

---

## If something goes wrong

**The email doesn't arrive.** The email comes from a shared test sender, which
only delivers to the address the email account was registered with. If you
changed the notification address on the Approvals page to anything else, change
it back. Emails also stop **silently** if notifications are switched off on that
page.

**The approval fails, or no row appears on the sheet.** The likeliest cause is
the service-account key: it is missing, wrong, or was rotated and Render still
has the old one. The other is that the service account has lost edit access to
the spreadsheet. Check the Render logs from the moment you pressed Approve, and
bring them to a Claude Code session.

---

## Not done yet (so don't be surprised)

- **Customers get no confirmation email.** That needs a verified sending domain.
- **Don't send the notifications to an office inbox yet.** With the shared test
  sender, the emails would stop arriving and nothing would warn you.
- **Nothing links to the form.** Once the test passes, someone needs to add a
  link to `/start` on Evergreen's website. That is outside this code.
