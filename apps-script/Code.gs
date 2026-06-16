/* ===========================================================================
 * pullhelper — Gmail email relay (Google Apps Script)
 * ---------------------------------------------------------------------------
 * Deploy this under the Google account you want emails to be SENT FROM
 * (e.g. playersuniongamecoop@gmail.com). It receives a PDF from the web app
 * and emails it as an attachment.
 *
 * DEPLOY STEPS
 *   1. Go to https://script.google.com  ->  New project.
 *   2. Delete the sample code, paste THIS file's contents, and Save.
 *   3. Click  Deploy  ->  New deployment.
 *   4. Type = "Web app".
 *        - Description: pullhelper relay
 *        - Execute as: Me (your account)
 *        - Who has access: Anyone
 *   5. Deploy. Approve the permissions prompt (it needs to send mail as you).
 *   6. Copy the "Web app" URL (ends in /exec).
 *   7. Paste that URL into config.js as RELAY_ENDPOINT, then commit + push.
 *
 * Re-deploying after edits: Deploy -> Manage deployments -> edit -> new version.
 * ======================================================================== */

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    if (!data.to || !data.pdf_base64) {
      return json_({ ok: false, error: "Missing 'to' or 'pdf_base64'." });
    }

    var blob = Utilities.newBlob(
      Utilities.base64Decode(data.pdf_base64),
      "application/pdf",
      data.filename || "decklist.pdf"
    );

    GmailApp.sendEmail(
      data.to,
      data.subject || ("Decklist from " + (data.name || "")),
      data.body || "Attached PDF for easy printing",
      { attachments: [blob], name: "Players Union Game Coop" }
    );

    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

// Simple GET responder so you can confirm the deployment is live in a browser.
function doGet() {
  return json_({ ok: true, service: "pullhelper relay" });
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
