FROM node:8

WORKDIR /opt

# the following is required for mosca to install correctly
RUN apt-get update && apt-get install libzmq-dev -y

ADD ./*.json /opt/
RUN npm install
ADD . /opt/
CMD ["node", "/opt/index.js"]
EXPOSE 1883
