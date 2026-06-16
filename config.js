// ---------------------------------------------------------------------------
// pullhelper configuration
// ---------------------------------------------------------------------------

window.PULLHELPER_CONFIG = {
  // Default recipient pre-filled in the email field.
  DEFAULT_EMAIL: "playersuniongamecoop@gmail.com",

  // URL of your deployed Google Apps Script web app (the email relay).
  // Leave blank until you deploy it (see apps-script/Code.gs for instructions).
  // Example: "https://script.google.com/macros/s/AKfycb..../exec"
  RELAY_ENDPOINT: "",

  // Milliseconds to wait between Scryfall API calls (their guidance: 50-100ms).
  SCRYFALL_DELAY_MS: 100,
};
