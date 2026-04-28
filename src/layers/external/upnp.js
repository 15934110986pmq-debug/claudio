const axios = require('axios');
require('dotenv').config();

// Pushes an audio URL to a UPnP/DLNA renderer via SOAP.
// Set UPNP_DEVICE_URL in .env to the AVTransport control URL of your device.
// e.g. UPNP_DEVICE_URL=http://192.168.1.100:49152/avcontrol

function soapEnvelope(action, serviceType, body) {
    return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="${serviceType}">
      ${body}
    </u:${action}>
  </s:Body>
</s:Envelope>`;
}

async function pushAudio(audioUrl, metadata = '') {
    const deviceUrl = process.env.UPNP_DEVICE_URL;
    if (!deviceUrl) {
        console.warn('[UPnP] UPNP_DEVICE_URL not set, skipping push');
        return false;
    }

    const serviceType = 'urn:schemas-upnp-org:service:AVTransport:1';

    try {
        // Step 1: SetAVTransportURI
        await axios.post(
            deviceUrl,
            soapEnvelope('SetAVTransportURI', serviceType,
                `<InstanceID>0</InstanceID>
                 <CurrentURI>${audioUrl}</CurrentURI>
                 <CurrentURIMetaData>${metadata}</CurrentURIMetaData>`),
            {
                headers: {
                    'Content-Type': 'text/xml; charset="utf-8"',
                    SOAPAction: `"${serviceType}#SetAVTransportURI"`
                },
                timeout: 5000
            }
        );

        // Step 2: Play
        await axios.post(
            deviceUrl,
            soapEnvelope('Play', serviceType,
                `<InstanceID>0</InstanceID><Speed>1</Speed>`),
            {
                headers: {
                    'Content-Type': 'text/xml; charset="utf-8"',
                    SOAPAction: `"${serviceType}#Play"`
                },
                timeout: 5000
            }
        );

        console.log('[UPnP] Pushed to device:', audioUrl);
        return true;
    } catch (err) {
        console.error('[UPnP] push error:', err.message);
        return false;
    }
}

module.exports = { pushAudio };
