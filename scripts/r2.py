"""Minimal S3-compatible client for Cloudflare R2 using AWS Signature Version 4. Standard library only."""
import datetime
import hashlib
import hmac
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

EMPTY_SHA256 = hashlib.sha256(b'').hexdigest()


def _encode(value, safe='-_.~'):
    return urllib.parse.quote(value, safe=safe)


def _canonical_path(path):
    return '/' + '/'.join(_encode(part) for part in path.lstrip('/').split('/'))


def _canonical_query(query):
    items = sorted((k, v) for k, v in (query or {}).items())
    return '&'.join(f'{_encode(k)}={_encode(str(v))}' for k, v in items)


def _hmac(key, message):
    return hmac.new(key, message.encode(), hashlib.sha256).digest()


def sign(method, host, path, query, headers, payload_hash, access_key, secret_key, region, service, amz_date):
    """Return the Authorization header for one request. `headers` must already contain host and x-amz-date."""
    canonical_headers = {k.lower().strip(): ' '.join(str(v).split()) for k, v in headers.items()}
    signed = ';'.join(sorted(canonical_headers))
    canonical_request = '\n'.join([
        method, _canonical_path(path), _canonical_query(query),
        ''.join(f'{k}:{canonical_headers[k]}\n' for k in sorted(canonical_headers)),
        signed, payload_hash])
    date = amz_date[:8]
    scope = f'{date}/{region}/{service}/aws4_request'
    string_to_sign = '\n'.join(['AWS4-HMAC-SHA256', amz_date, scope, hashlib.sha256(canonical_request.encode()).hexdigest()])
    key = _hmac(_hmac(_hmac(_hmac(('AWS4' + secret_key).encode(), date), region), service), 'aws4_request')
    signature = hmac.new(key, string_to_sign.encode(), hashlib.sha256).hexdigest()
    return f'AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed}, Signature={signature}'


class R2Client:
    def __init__(self, account_id, bucket, access_key, secret_key, opener=None):
        if not account_id or not bucket or not access_key or not secret_key:
            raise ValueError('R2 account, bucket and credentials are required')
        self.host = f'{account_id}.r2.cloudflarestorage.com'
        self.bucket = bucket
        self.access_key = access_key
        self.secret_key = secret_key
        self.opener = opener or urllib.request.urlopen

    def _request(self, method, key='', query=None, body=b'', content_type=None):
        path = f'/{self.bucket}' + (f'/{key}' if key else '')
        payload_hash = hashlib.sha256(body).hexdigest() if body else EMPTY_SHA256
        amz_date = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        headers = {'host': self.host, 'x-amz-content-sha256': payload_hash, 'x-amz-date': amz_date}
        if content_type:
            headers['content-type'] = content_type
        headers['Authorization'] = sign(method, self.host, path, query, {k: v for k, v in headers.items()}, payload_hash,
                                        self.access_key, self.secret_key, 'auto', 's3', amz_date)
        url = f'https://{self.host}{_canonical_path(path)}'
        if query:
            url += '?' + _canonical_query(query)
        request = urllib.request.Request(url, data=body if body else None, method=method)
        for k, v in headers.items():
            if k != 'host':
                request.add_header(k, v)
        with self.opener(request, timeout=120) as response:
            return response.status, response.read()

    def put_object(self, key, body, content_type='application/octet-stream'):
        status, _ = self._request('PUT', key, body=body, content_type=content_type)
        return status

    def get_object(self, key):
        _, body = self._request('GET', key)
        return body

    def delete_object(self, key):
        status, _ = self._request('DELETE', key)
        return status

    def list_objects(self, prefix):
        """Return [(key, size, last_modified_iso)] under a prefix; follows continuation tokens."""
        results, token = [], None
        while True:
            query = {'list-type': '2', 'prefix': prefix}
            if token:
                query['continuation-token'] = token
            _, body = self._request('GET', query=query)
            root = ET.fromstring(body)
            ns = root.tag.split('}')[0] + '}' if root.tag.startswith('{') else ''
            for item in root.findall(f'{ns}Contents'):
                results.append((item.findtext(f'{ns}Key'), int(item.findtext(f'{ns}Size') or 0), item.findtext(f'{ns}LastModified')))
            if root.findtext(f'{ns}IsTruncated') == 'true':
                token = root.findtext(f'{ns}NextContinuationToken')
            else:
                return results
