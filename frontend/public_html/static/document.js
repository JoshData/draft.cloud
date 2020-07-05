draftdotcloud_widget_options = {
  sizeTo: "container",
  placeholder: "Share this page’s address with anyone you would like to edit with."
};

function resize_widget() {
  $('#editor').height(
    window.innerHeight
    - $('nav').outerHeight()
    - $('footer').outerHeight());
}
resize_widget();
$(window).resize(resize_widget);

$('#show-api').click(function() {
  show_api_info();
  return false;
})
$('#fork-document').click(function() {
  fork_document();
  return false;
})
$('#do-merge').click(function() {
  merge_document();
  return false;
})

function ddc_api_call(apiendpoint, method, data, success) {
  jQuery.ajax({
    method: method,
    url: apiendpoint,
    data: JSON.stringify(data),
    contentType: 'application/json',
    success: success,
    error: function(xhr, error, message) {
      if (/^text\/plain(;|$)/.test(xhr.getResponseHeader("content-type")))
        alert(xhr.responseText)
      else
        alert(message);
    }
  });
}

function make_editable(elem, title, explanation, apiendpoint) {
  elem.addClass('editable');
  elem.attr("title", title);
  elem.click(function() {
    // Prompt. Check for cancel or no change.
    var old_name = $(elem).text();
    var new_name = prompt(title + "? " + explanation + " " + $('#valid-name-text').text(), old_name);
    if (!new_name || new_name == old_name)
      return;

    // Submit.
    ddc_api_call(apiendpoint, "PUT", { "name": new_name }, function(res) {
      // Update label & browser URL.
      elem.text(res.name);
      window.history.pushState(null, "", "/edit/" + $('#document-owner-name').text() + "/" + $('#document-name').text());
    });
  });
}

function get_document_api() {
  return "/api/v1/documents/" + $('#owner-id').text() + "/" + $('#document-id').text();
}

if ($('#owner-id').attr('can-rename-owner'))
make_editable(
  $('#document-owner-name'),
  "Change Your Name",
  "Give yourself a Draft.Cloud username. If you have shared this or other documents already, changing your username will break the links you have shared.",
  "/api/v1/users/" + $('#owner-id').text());

if ($('#document-id').attr('can-rename-document'))
make_editable(
  $('#document-name'),
  "Change Document Name",
  "Give this document a short name so it has a pretty URL. Changing the document's name changes its address, so if you have shared this document already you will need to send your collaborators a new link.",
  get_document_api());

var access_level_toggle = $('#access_level_toggle');
function update_public_access_level() {
  access_level_toggle.parent().show(); // on first call
  var leveltext = "Access Level";
  if (access_level_toggle.attr("data-value") == "NONE")
    leveltext = "Private Document";
  else if (access_level_toggle.attr("data-value") == "READ")
    leveltext = "Anyone Can Read";
  else if (access_level_toggle.attr("data-value") == "WRITE")
    leveltext = "Anyone Can Edit";
  access_level_toggle.text(leveltext);
}
update_public_access_level();
access_level_toggle.click(function() {
  var level = "NONE";
  if (access_level_toggle.attr("data-value") == "NONE")
    level = "READ";
  else if (access_level_toggle.attr("data-value") == "READ")
    level = "WRITE";
  ddc_api_call(
      get_document_api(), "PUT",
      { "public_access_level": level }, function(res) {
        access_level_toggle.attr("data-value", res.public_access_level);
        update_public_access_level();
    });
});

function fork_document() {
  // Get the current revision of the document.
  ddc_api_call(get_document_api(), "GET", 
    { }, function(res) {
    ddc_api_call("/api/v1/documents/me", "POST", 
      {
        forkedFrom: res.latestRevision.id
      }, function(res) {
        window.location = res.web_urls.document;
    });
  });
}

function merge_document() {
  // Get the current revision of the document.
  ddc_api_call(get_document_api(), "GET", 
    { }, function(res) {
     window.location = res.forkedFrom.api_urls.document + "/merge/" + res.latestRevision.id;
  });
}

function show_api_info() {
  $('#api-info').modal();
}

