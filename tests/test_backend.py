from io import BytesIO
import json
import time
import zipfile
import pytest
from PIL import Image
from pypdf import PdfWriter
from backend.app import create_app, document_parts, normalize_result, Problem, MAX_FILE, generate

CATS = [{'id': 'foundation', 'name': 'Fundație', 'subcategories': [{'id': 'concrete', 'name': 'Beton'}]}]
GOOD = {'beneficiary': 'Furnizor Fictiv SRL', 'description': 'Beton', 'amount': 1200.50,
        'currency': 'RON', 'paymentDate': '2026-11-20', 'invoiceDate': '2026-11-19',
        'categoryId': 'foundation', 'subcategoryId': 'concrete', 'invoiceNumber': 'TEST-123', 'warnings': []}
ORIGIN = 'https://krintea.github.io'

def png():
    b = BytesIO(); Image.new('RGB', (20, 20), 'white').save(b, 'PNG'); return b.getvalue()

def pdf(pages=1, password=False):
    p = PdfWriter()
    for _ in range(pages): p.add_blank_page(width=100, height=100)
    if password: p.encrypt('test')
    b = BytesIO(); p.write(b); return b.getvalue()

def docx(xml=None, media=False):
    b = BytesIO()
    with zipfile.ZipFile(b, 'w') as z:
        z.writestr('[Content_Types].xml', '<Types/>')
        z.writestr('word/document.xml', xml or '<w:document xmlns:w="urn:word"><w:p><w:t>Furnizor Fictiv 1.200,50 RON</w:t></w:p></w:document>')
        if media: z.writestr('word/media/image1.png', png())
    return b.getvalue()

def setup(**overrides):
    generated = []
    claims = {'sub': 'owner', 'aud': 'client', 'iss': 'https://accounts.google.com', 'exp': time.time()+3600}
    def verify(token, audience):
        if token == 'bad': raise ValueError('invalid signature')
        return {**claims, **overrides.pop('claims', {})}
    def model(parts, cats, config):
        generated.append(parts); return GOOD
    config = {'TESTING': True, 'CLIENT_ID': 'client', 'ALLOWED_SUBS': {'owner'}, 'ENABLED': True}
    config.update(overrides)
    app = create_app(config, verifier=verify, generator=model)
    return app.test_client(), generated

def post(c, data=None, filename='invoice.png', token='valid', origin=ORIGIN, cats=None):
    return c.post('/analyze', headers={'Authorization': 'Bearer '+token, 'Origin': origin},
        data={'document': (BytesIO(data if data is not None else png()), filename), 'categories': json.dumps(CATS if cats is None else cats)})

@pytest.mark.parametrize('data,name', [(png(), 'photo.png'), (pdf(), 'invoice.pdf'), (docx(media=True), 'invoice.docx')])
def test_supported_documents_extract_without_persistence(data, name):
    c, calls = setup(); r = post(c, data, name)
    assert r.status_code == 200 and r.json['payment']['amount'] == 1200.5
    assert r.json['payment']['categoryId'] == 'foundation' and len(calls) == 1
    assert r.headers['Cache-Control'] == 'no-store'

def test_docx_text_and_image():
    parts = document_parts(docx(media=True), 'x.docx')
    assert '1.200,50 RON' in parts[0]['text'] and parts[1]['inlineData']['mimeType'] == 'image/jpeg'

@pytest.mark.parametrize('data,name', [(b'fake', 'x.pdf'), (b'fake', 'x.png'), (b'fake', 'x.docx'),
        (png(), 'x.exe'), (pdf(31), 'x.pdf'), (pdf(password=True), 'x.pdf'), (b'', 'x.png'),
        (b'x'*(MAX_FILE+1), 'x.png'), (docx('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>'), 'x.docx')])
def test_reject_unsafe_documents(data, name):
    c, calls = setup(); r = post(c, data, name)
    assert r.status_code in (400, 413, 415) and not calls

@pytest.mark.parametrize('claims,status', [({'sub': 'other'}, 403), ({'exp': 1}, 401),
        ({'aud': 'wrong'}, 401), ({'iss': 'evil'}, 401)])
def test_wrong_identity(claims, status):
    c, calls = setup(claims=claims); assert post(c).status_code == status and not calls

def test_invalid_signature_and_origin():
    c, calls = setup()
    assert post(c, token='bad').status_code == 401
    assert post(c, origin='https://evil.example').status_code == 403
    assert c.post('/analyze', headers={'Origin': ORIGIN}).status_code == 401
    assert not calls

def test_disabled_and_unconfigured_fail_closed():
    for config in ({'ENABLED': False}, {'ALLOWED_SUBS': set()}, {'CLIENT_ID': ''}):
        c, calls = setup(**config); assert post(c).status_code == 503 and not calls

def test_cors_preflight():
    c, _ = setup()
    r = c.options('/analyze', headers={'Origin': ORIGIN})
    assert r.status_code == 204 and r.headers['Access-Control-Allow-Origin'] == ORIGIN
    assert c.options('/analyze', headers={'Origin': 'null'}).status_code == 403

def test_rate_limit_before_model():
    c, calls = setup()
    for _ in range(3): assert post(c).status_code == 200
    assert post(c).status_code == 429 and len(calls) == 3

def test_untrusted_categories():
    c, calls = setup(); assert post(c, cats=[{'id':'x'}]).status_code == 400 and not calls

def test_missing_and_multiple_files():
    c, calls = setup()
    h = {'Origin': ORIGIN, 'Authorization': 'Bearer valid'}
    assert c.post('/analyze', headers=h, data={}).status_code == 400
    assert c.post('/analyze', headers=h, data={'document':[(BytesIO(png()),'a.png'), (BytesIO(png()),'b.png')]}).status_code == 400
    assert not calls

def test_category_dates_currency_sanitization():
    r = normalize_result({**GOOD, 'paymentDate': '2026-02-30', 'categoryId': 'made-up', 'currency':'USD'}, CATS)
    assert r['paymentDate'] is None and r['categoryId'] is None and r['amount'] is None
    assert r['invoiceDate'] == GOOD['invoiceDate'] and r['warnings']
    assert normalize_result({**GOOD, 'subcategoryId':'made-up'}, CATS)['subcategoryId'] is None

def test_multiple_payments_no_guessed_total():
    r = normalize_result({**GOOD, 'multiplePayments': True}, CATS)
    assert r['amount'] is None and r['beneficiary'] is None and r['warnings']

@pytest.mark.parametrize('amount', [True, -1, float('nan'), float('inf'), 1e12, '1.200,50'])
def test_invalid_amounts(amount):
    assert normalize_result({**GOOD, 'amount':amount}, CATS)['amount'] is None

def test_upstream_error_redacted():
    def model(*args): raise RuntimeError('private invoice contents')
    app = create_app({'TESTING': True, 'CLIENT_ID':'client', 'ALLOWED_SUBS':{'owner'}, 'ENABLED':True},
        verifier=lambda *args: {'sub':'owner','aud':'client','iss':'accounts.google.com','exp':time.time()+60}, generator=model)
    r = post(app.test_client()); assert r.status_code == 503 and b'private' not in r.data

def test_google_signature_verification_with_real_signed_tokens(monkeypatch):
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives import serialization
    from google.auth import jwt, crypt
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    public = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    signer = crypt.RSASigner.from_string(private, key_id='test-key')
    class CertResponse:
        status = 200
        data = json.dumps({'test-key': public}).encode()
    monkeypatch.setattr('backend.app.Request', lambda: lambda *args, **kwargs: CertResponse())
    app = create_app({'TESTING':True, 'CLIENT_ID':'client', 'ALLOWED_SUBS':{'owner'}, 'ENABLED':True}, generator=lambda *args: GOOD)
    c=app.test_client()
    claims={'iss':'https://accounts.google.com', 'aud':'client','sub':'owner','iat':int(time.time())-10,'exp':int(time.time())+300}
    token=jwt.encode(signer,claims).decode()
    assert post(c,token=token).status_code==200
    assert post(c,token=jwt.encode(signer,{**claims,'aud':'other-client'}).decode()).status_code==401
    assert post(c,token=jwt.encode(signer,{**claims,'exp':1}).decode()).status_code==401
    segments=token.split('.'); segments[2]='A'+segments[2][1:]
    assert post(c,token='.'.join(segments)).status_code==401
