// ---------------------------------------------------------------------------
// pullhelper configuration
// ---------------------------------------------------------------------------

window.PULLHELPER_CONFIG = {
  // Default recipient pre-filled in the email field.
  DEFAULT_EMAIL: "playersuniongamecoop@gmail.com",

  // URL of your deployed Google Apps Script web app (the email relay).
  // Leave blank until you deploy it (see apps-script/Code.gs for instructions).
  // Example: "https://script.google.com/macros/s/AKfycb..../exec"
  RELAY_ENDPOINT: "https://script.google.com/macros/s/AKfycby1TEAoso7apSRL2QZFxOiHu1dTOSgWOuglm2QgSJcKymVlRy-O4AwYEFayWYX4jCPZ5g/exec",

  // Milliseconds to wait between Scryfall API calls (their guidance: 50-100ms).
  SCRYFALL_DELAY_MS: 100,
};
