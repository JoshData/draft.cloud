# Draft.Cloud

(This project is not open source.)

## Installation

Install node and packages:

	cd ~ # go to home directory, nvm install gets confused if there's a .git dir
	curl -o- https://raw.githubusercontent.com/creationix/nvm/v0.33.3/install.sh | bash
	nvm install $(nvm ls-remote | tail -1)

	cd draft.cloud
	npm install

If running with a Postgres database:

	npm install pg # requires Postgresql's JSON column type

Configure Draft.Cloud:

	mkdir local
	nano local/environment.json

In `local/environment.json`:

	{
	  "https": true,
	  "port": 3005,
	  "url": "https://draft.cloud",
	  "allow_anonymous_user_creation": false,
	  "secret_key": "...",
	  "GITHUB_CLIENT_ID": "...",
	  "GITHUB_CLIENT_SECRET": "...",
	  "database": "postgresql://draftdotcloud:...@localhost/draftdotcloud"
	}

Test functionality:

	./build.sh
	node index.js
	  ^C it once it starts running

Testing using the command line & browser. Install `jq` first.

	# Create a new user:
	backend/req POST '' users

	# The user's API key is returned in the X-Api-Key HTTP header.
	# Copy it into an environment variable:
	export API_KEY=(copy X-Api-Key header here)

	# Create a document:
	backend/req POST '' documents/me

	# Copy the "web_urls" => "document" value into your browser to
	# edit the document. Lose the URL? List your documents:
	backend/req GET '' documents/me
	

## Deployment

Configure nginx and supervisor:

	sudo ln -sf /home/draftdotcloud/draft.cloud/conf/nginx.conf /etc/nginx/sites-enabled/draftdotcloud
	sudo ln -sf /home/draftdotcloud/draft.cloud/conf/supervisor.ini /etc/supervisor/conf.d/draftdotcloud.conf

## Development

Run tests:

	npm test

Build documentation:

	node_modules/spectacle-docs/bin/spectacle.js -t public_html/apidocs/v1 backend/swagger.yaml