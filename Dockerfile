# docker build -t draftdotcloud/draftdotcloud-server .

FROM node:14

WORKDIR /usr/src/app

EXPOSE 8000
ENV BIND_HOST=0.0.0.0
ENV PORT=8000

COPY package*.json ./
COPY index.js ./
COPY build.sh ./
COPY backend ./backend
COPY frontend ./frontend
COPY widgets ./widgets

RUN npm install
RUN npm install pg
RUN ./build.sh

CMD [ "node", "index.js" ]