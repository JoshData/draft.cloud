// This bundles our Javascript resources for the client.
// Build with:
//
// browserify -d draft-cloud-widgets/browserfy_root.js -o public_html/draftdotcloud.js
//

// Add LINK/SCRIPT tags.
var jsoneditor = require("./jsoneditor.js").jsoneditor;

// Let other initialization occur before we actually start initialization,
// including enough time to load the JSONEditor CSS & JS.
setTimeout(init, 100);

var log_receivers = [];

function init() {
  // Activate any elements with data-draftdotcloud-{owner,document,apikey}
  // attributes.
  var elements = document.getElementsByClassName("draftdotcloud-widget");
  for (var i = 0; i < elements.length; i++) {
    var elem = elements[i];

    var widget;
    if (elem.tagName == "TEXTAREA")
      widget = require("./textarea.js").textarea;
    else if (elem.tagName == "DIV" && elem.getAttribute("data-draftdotcloud-widget") == "jsoneditor")
      widget = jsoneditor;
    else
      // invalid
      continue;

    var owner_name = elem.getAttribute("data-draftdotcloud-owner");
    var document_name = elem.getAttribute("data-draftdotcloud-document");
    var api_key = elem.getAttribute("data-draftdotcloud-apikey");
    if (!owner_name || !document_name) continue;

    console.log("attaching draft.cloud widget to", elem);
    var client = require("./client.js").Client(
      owner_name,
      document_name,
      api_key,
      require("./websocket.js"), // or require("./ajax_polling.js")
      new widget(elem),
      function(doc, msg) {
        log_receivers.forEach(function(recip) {
          recip(doc, msg);
        })
      }
    );
  }
}

global.draft_cloud_on_event = function(log_recipient) {
  log_receivers.push(log_recipient);
}
