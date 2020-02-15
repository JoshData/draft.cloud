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
    jQuery.ajax({
      method: "PUT",
      url: apiendpoint,
      data : JSON.stringify({ "name": new_name }),
      contentType: 'application/json',
      success: function(res) {
        // Update label & browser URL.
        elem.text(res.name);
        window.history.pushState(null, "", "/edit/" + $('#document-owner-name').text() + "/" + $('#document-name').text());
      },
      error: function(xhr, error, message) {
        if (/^text\/plain(;|$)/.test(xhr.getResponseHeader("content-type")))
          alert(xhr.responseText)
        else
          alert(message);
      }
    })
  });
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
  "/api/v1/documents/" + $('#owner-id').text() + "/" + $('#document-id').text());

function show_api_info() {
  $('#api-info').modal();
}