 Refresh the certs with:

   curl -s http://crt.sectigo.com/GoGetSSLRSADVSSLCA2.crt \     
    | openssl x509 -inform DER -out certs/gogetssl-rsa-dv-ca2.pem
