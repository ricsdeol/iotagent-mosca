#!/bin/sh
/opt/initialConf.py
if [ $? -ne 0 ]; then
    echo "Error ocurred on initial mosca TLS setup"
    return -1
fi

node /opt/index.js