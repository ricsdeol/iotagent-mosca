#!/usr/bin/python
# This script makes the initial configuration to use TLS with mosca.
# It generates the mosca key-pair
# and retrieves a certificate and CRL from CA.
# If the configuration has already been done, this script does nothing!

import conf
import os
import binascii
from OpenSSL import crypto
import certUtils
from time import sleep
import requests


def generateKeys():
    if not os.path.isfile(conf.certsDir + 'mosca.key'):
        certUtils.generatePrivateKey(conf.certsDir + "/mosca.key",
                                     conf.keyLength)
        print "mosca key-pair created"


def generateCSR():
    if not os.path.isfile(conf.certsDir + "/mosca.csr"):
        certUtils.generateCSR(CName='mosca',
                              privateKeyFile=conf.certsDir + "/mosca.key",
                              csrFileName=conf.certsDir + "/mosca.csr",
                              dnsname=['mqtt', 'mosca', 'localhost'])


def askCertSign():
    if not os.path.isfile(conf.certsDir + "/mosca.crt"):
        passwd = binascii.b2a_hex(os.urandom(16))
        try:
            certUtils.createEJBCAUser(conf.EJBCA_API_URL, conf.CAName,
                                      "mosca", passwd)
        except certUtils.EJBCARESTException as err:
            print("Cant create EJBCA user. Error: " + err.message)
            exit(-1)
        try:
            cert = certUtils.signCert(conf.EJBCA_API_URL,
                                      conf.certsDir + "/mosca.csr",
                                      "mosca", passwd)
        except certUtils.EJBCARESTException as err:
            print("Cant sign the CRT. EJBCA-REST return code: " + err.message)
            exit(-1)
        certUtils.saveCRT(conf.certsDir + "/mosca.crt", cert)
        print("mosca certificate signed")


def retrieveCAChain():
    if not os.path.isfile(conf.certsDir + "/ca.crt"):
        try:
            rawCrt = certUtils.retrieveCAChain(conf.EJBCA_API_URL, conf.CAName)
            certUtils.saveCRT(conf.certsDir + "/ca.crt", rawCrt)
            print("CA certificates retrieved")
        except KeyError:
            print "Invalid answer returned from EJBCA."
            exit(-1)


def retrieveCRL():
    if not os.path.isfile(conf.certsDir + "/ca.crl"):
        try:
            rawCRL = certUtils.retrieveCACRL(conf.EJBCA_API_URL, conf.CAName)
            certUtils.saveCRL(conf.certsDir + "/ca.crl", rawCRL)
        except KeyError:
            print "Invalid answer returned from EJBCA."
            exit(-1)
        except crypto.Error:
            print("Could not decode retrieved CRL")
            exit(-1)


if __name__ == '__main__':
    while True:
        try:
            print("Retrieving CA Chain")
            retrieveCAChain()
            print("Generating keys")
            generateKeys()
            print("Generating CSR")
            generateCSR()
            print("Asking certification signature")
            askCertSign()
            print("Retrieving CRL")
            retrieveCRL()
            break
        except requests.exceptions.ConnectionError:
            print("Cant connect to EJBCA server at "
                  + conf.EJBCA_API_URL + " for initial configuration")
            print("Chances are the server is not ready yet."
                  " Will retry in 30sec")
            sleep(30)
exit(0)
