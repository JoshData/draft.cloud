# Draft.Cloud

(This project is not open source.)

## Installation

Install node and packages:

	cd ~ # go to home directory, nvm install gets confused if there's a .git dir
	curl -o- https://raw.githubusercontent.com/creationix/nvm/v0.33.3/install.sh | bash
	nvm install $(nvm ls-remote | tail -1)

	cd draft.cloud
	npm install

	npm uninstall sqlite3 # it causes pkg mgmt issues
	npm install pg # requires Postgresql's JSON column type, pg 6.4.4 until https://github.com/sequelize/sequelize/issues/8043 is fixed

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
	  "database": "mysql://draftdotcloud:...@localhost/draftdotcloud"
	}

Test functionality:

	node index.js
	  ^C it once it starts running

Configure nginx and supervisor:

	sudo ln -sf /home/draftdotcloud/draft.cloud/conf/nginx.conf /etc/nginx/sites-enabled/draftdotcloud
	sudo ln -sf /home/draftdotcloud/draft.cloud/conf/supervisor.ini /etc/supervisor/conf.d/draftdotcloud.conf
