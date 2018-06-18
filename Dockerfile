FROM node:8

WORKDIR /opt

# the following is required for mosca to install correctly
RUN apt-get update && apt-get install libzmq-dev -y

RUN apt-get update \
	&& apt-get install -y python-openssl python-pip \
&& pip install requests kafka

ADD ./*.json /opt/
RUN npm install
ADD . /opt/

#Create dir for allocate tls auth files
RUN mkdir -p /opt/mosca/certs/

EXPOSE 8883
EXPOSE 1883
CMD ["/opt/entrypoint.sh"]
