"""Signature V4 correctness against the published AWS example; no network is used."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import r2


class SignatureTests(unittest.TestCase):
    def test_matches_aws_get_object_example(self):
        # AWS "Signature Calculations for the Authorization Header" example: GET Object with a Range header.
        authorization = r2.sign(
            'GET', 'examplebucket.s3.amazonaws.com', '/test.txt', None,
            {'host': 'examplebucket.s3.amazonaws.com', 'range': 'bytes=0-9',
             'x-amz-content-sha256': r2.EMPTY_SHA256, 'x-amz-date': '20130524T000000Z'},
            r2.EMPTY_SHA256, 'AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
            'us-east-1', 's3', '20130524T000000Z')
        self.assertTrue(authorization.endswith('Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'))
        self.assertIn('SignedHeaders=host;range;x-amz-content-sha256;x-amz-date', authorization)

    def test_canonical_encoding_of_paths_and_queries(self):
        self.assertEqual(r2._canonical_path('/paced-backups/backups/2026 11/a b.tar.gpg'), '/paced-backups/backups/2026%2011/a%20b.tar.gpg')
        self.assertEqual(r2._canonical_query({'prefix': 'ledger/', 'list-type': '2'}), 'list-type=2&prefix=ledger%2F')

    def test_client_requires_credentials_and_signs_requests(self):
        with self.assertRaises(ValueError):
            r2.R2Client('acct', 'bucket', '', '')
        seen = {}

        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return b'<ListBucketResult><Contents><Key>backups/x</Key><Size>5</Size><LastModified>2026-11-03T00:00:00Z</LastModified></Contents><IsTruncated>false</IsTruncated></ListBucketResult>'

        def opener(request, timeout):
            seen['url'] = request.full_url
            seen['auth'] = request.get_header('Authorization')
            return Response()
        client = r2.R2Client('acct', 'paced-backups', 'AK', 'SK', opener=opener)
        self.assertEqual(client.list_objects('backups/'), [('backups/x', 5, '2026-11-03T00:00:00Z')])
        self.assertEqual(seen['url'], 'https://acct.r2.cloudflarestorage.com/paced-backups?list-type=2&prefix=backups%2F')
        self.assertTrue(seen['auth'].startswith('AWS4-HMAC-SHA256 Credential=AK/'))
        self.assertNotIn('SK', seen['auth'])


if __name__ == '__main__':
    unittest.main()
