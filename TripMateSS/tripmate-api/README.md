# TripMate

TripMate เป็นระบบจัดการทริปที่ประกอบด้วย REST API, PostgreSQL และ Frontend

## โครงสร้างโปรเจกต์

- tripmate-api/     Backend REST API
- tripmate-frontend/ Frontend HTML
- tripmate-api/db/init.sql     Database schema

## สิ่งที่ต้องติดตั้ง

ก่อนเริ่มใช้งาน ต้องมี:

- Docker Desktop
- Python 3
- Web Browser เช่น Chrome

## 1. เปิด Backend

เปิด CMD แล้วเข้าโฟลเดอร์:

cd tripmate-api

สร้างไฟล์ `.env` จากตัวอย่างก่อน (PowerShell):

```powershell
Copy-Item .env.example .env
notepad .env
```

กรอก `POSTGRES_PASSWORD` เป็นรหัสผ่านเฉพาะเครื่อง (แนะนำตัวอักษร/ตัวเลขเพื่อเลี่ยงปัญหา URL encoding) และตั้ง `JWT_SECRET` เป็นค่าสุ่มยาวอย่างน้อย 32 ตัวอักษร เช่น สร้างด้วย Python: `py -c "import secrets; print(secrets.token_hex(32))"` แล้วนำค่าที่ได้ไปใส่ `JWT_SECRET` ห้ามส่งไฟล์ `.env` ให้เพื่อนหรือ commit เข้า Git

จากนั้นรัน:

```powershell
docker compose up --build
```

ห้ามปิดหน้าต่าง CMD นี้ขณะทดสอบระบบ

## 2. ตรวจสอบ Backend

เปิด Browser แล้วเข้า:

http://localhost:3000/health

ถ้าระบบทำงานถูกต้อง ควรเห็น:

{"status":"ok","service":"tripmate-api",...}

## 3. เปิด Frontend

เปิด CMD อีกหน้าต่างหนึ่ง

เข้าโฟลเดอร์:

cd tripmate-frontend

จากนั้นรัน:

py -m http.server 5500

แล้วเปิด Browser:

http://localhost:5500/tripmate_frontend_api.html

## 4. สร้างบัญชีผู้ใช้

เมื่อเปิดหน้า Login:

1. เลือกสร้างผู้ใช้งานใหม่
2. กรอก Display Name
3. กรอก Username
4. กรอก Email
5. กรอก Password
6. ยืนยัน Password
7. สมัครสมาชิก

จากนั้นสามารถ Login ด้วยบัญชีที่สร้างขึ้นได้

## 5. การพัฒนา Backend

Backend อยู่ใน:

tripmate-api/src/server.js

Database schema อยู่ใน:

tripmate-api/db/init.sql

Docker configuration อยู่ใน:

tripmate-api/docker-compose.yml

## 6. Database

ระบบใช้ PostgreSQL ผ่าน Docker

Database schema ถูกสร้างจาก:

tripmate-api/db/init.sql

ไฟล์ init.sql เป็น schema สำหรับสร้างฐานข้อมูลใหม่ ไม่ใช่ database backup

## 7. Environment

ไฟล์ .env.example เป็นตัวอย่าง configuration

ห้ามนำ secret หรือ credential จริงใส่ใน repository

ไฟล์ .env ถ้ามี ต้องไม่ส่งต่อและไม่ควร commit เข้า Git

## 8. การหยุดระบบ

เมื่อทดสอบเสร็จ สามารถหยุด Docker ได้ด้วย:

docker compose down

คำสั่งนี้หยุดและลบ container/network ของ Compose แต่ไม่ได้ใช้แทนการ backup database

## 9. ข้อควรระวัง

- อย่าแก้ไขไฟล์ในโปรเจกต์หลักของเจ้าของงานโดยตรง
- อย่าแชร์ password จริง
- อย่าแชร์ API key จริง
- อย่าแชร์ไฟล์ .env ที่มี secret จริง
- Backend จำกัด CORS ตาม `CORS_ORIGINS` และไม่เริ่มทำงานหาก `JWT_SECRET` ไม่ได้ตั้งหรือสั้นกว่า 32 ตัวอักษร
- สมาชิกที่ยังไม่ joined จะเข้าถึงข้อมูลทริปไม่ได้
- เฉพาะเจ้าของทริปเท่านั้นที่บันทึกการชำระเงินแทนสมาชิกคนอื่นได้; สมาชิกบันทึกได้เฉพาะของตัวเอง
- รายชื่อผู้ใช้ไม่ส่งอีเมลของคนอื่นกลับไปใน directory endpoint
- ก่อนแก้ Database ควรทำ backup
- หลังแก้ฟีเจอร์ควรทดสอบ API และ Frontend

## 10. จุดเริ่มต้นสำหรับพัฒนาต่อ

แนะนำให้เริ่มจาก:

1. ตรวจสอบ Backend
2. ตรวจสอบ Authentication
3. ตรวจสอบ Trips
4. ตรวจสอบ Members
5. ตรวจสอบ Activities
6. ตรวจสอบ Accommodations
7. ตรวจสอบ Payments
8. จากนั้นจึงเพิ่มฟีเจอร์ใหม่


## Payment slip attachments
Payment records accept an optional multipart file field named `slip`. Supported formats: JPEG, PNG, WebP; maximum 5 MB. Files are stored in the private `/app/uploads` directory backed by the Compose `payment_slips` volume and are served only through the authenticated route `GET /api/trips/:id/payments/:paymentId/slip`. Existing databases are updated additively with `payments.slip_path`; no tables or records are dropped. Treat slips as private personal/financial information and back up the `payment_slips` volume along with the database when needed.


## Standalone trip Checkpoints (name + Google Maps URL)
- The API frontend includes a separate **หมุด Checkpoint** section under **แพลนเที่ยว**. Add a plain-text place name and paste the HTTPS share URL from Google Maps; the map link opens in a new tab.
- Checkpoints can be added, edited, deleted, and reordered with the up/down controls. They are saved independently from the time-based itinerary activities and belong to a trip.
- Endpoints (all require a bearer token and trip membership): `GET /api/trips/:id/checkpoints`, `POST /api/trips/:id/checkpoints` with `{ "name": "วัดอรุณราชวราราม", "google_maps_url": "https://maps.app.goo.gl/..." }`, `PUT /api/trips/:id/checkpoints/:checkpointId`, and `DELETE /api/trips/:id/checkpoints/:checkpointId`.
- Existing database volumes are updated with an additive `CREATE TABLE IF NOT EXISTS checkpoints` migration. Existing tables and trip data are not reset or deleted. Back up the database before any production schema change as a general precaution.

## Itinerary Google Maps checkpoints and accommodation search
- Activities support an optional `google_maps_url` field. The backend accepts HTTPS Google Maps links only for this field and stores it in the additive `activities.google_maps_url` column.
- Existing Docker database volumes are migrated automatically using `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`; no itinerary or payment rows are deleted.
- In the itinerary form, paste a Google Maps share URL. For regular Google Maps place URLs, the UI tries to fill the place name from the URL; review the name before saving. Saved itinerary items show a link to open the checkpoint in Google Maps.
- Accommodation search opens live external search results on Google Maps and Booking.com based on area and stay dates. Results, room availability, reviews, and prices are provided by those external sites, not fetched or verified by TripMate. Enter the chosen accommodation's name, approximate trip price, address, and link to save it to the trip.
- Hotel search opens Google Maps and Booking.com search links directly. No Google Places API key or paid hotel API is required. TripMate does not import live hotel listings, prices, ratings, or room availability; users can manually save a selected property into the trip.


## 7. เชื่อมต่อรายการที่พักจริงจาก Google Places API

TripMate ใช้ Google Places API (New) เพื่อค้นหารายชื่อที่พักตามพื้นที่ และแสดงชื่อ/ที่อยู่/ลิงก์ Google Maps ภายในหน้า ที่พัก ส่วนราคาและห้องว่างยังต้องตรวจสอบจากเว็บจองโดยตรง

1. เปิด [Google Cloud Console](https://console.cloud.google.com/)
2. เลือกหรือสร้างโปรเจกต์ และเปิด Billing ตามข้อกำหนดของ Google Maps Platform
3. เปิดใช้ **Places API (New)** แล้วสร้าง API key
4. จำกัด API key ให้ใช้กับ Places API เท่าที่จำเป็น และตั้ง quota/budget alert เพื่อควบคุมค่าใช้จ่าย
5. ใส่ key ในไฟล์ `tripmate-api/.env`:

```dotenv
```

6. สั่ง `docker compose up --build` ใหม่เพื่อให้ API อ่านค่าล่าสุด
7. เปิดหน้า ที่พัก แล้วค้นหาพื้นที่ เช่น `เชียงใหม่` หรือ `เกาะล้าน`

API key ถูกเรียกจาก Backend เท่านั้น ไม่ใส่ไว้ใน HTML/JavaScript ฝั่งผู้ใช้ และห้ามแชร์ `.env` หรือ commit key ขึ้น Git

หมายเหตุ: API นี้ค้นหารายชื่อสถานที่ ไม่ได้คืนราคาเข้าพักหรือยืนยันห้องว่างตามวันที่/จำนวนผู้เข้าพัก ดังนั้น TripMate จะไม่สร้างราคา/คะแนนปลอม และยังให้เปิด Booking.com เพื่อตรวจสอบราคาและ availability จริง

## Authentication and user-management API

All protected endpoints require `Authorization: Bearer <token>`. Passwords are hashed with bcrypt; the API never returns `password_hash`.

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/auth/register` | No | Create account and start a session |
| `POST` | `/api/auth/login` | No | Login with username or email and password |
| `POST` | `/api/auth/logout` | Yes | Revoke the current session/token |
| `POST` | `/api/auth/change-password` | Yes | Change password; revokes all sessions |
| `GET` | `/api/me` | Yes | Current user's profile |
| `GET` | `/api/users?page=1&limit=20&q=tan` | Yes | Paginated user directory (limit 1-100; optional search) |
| `GET` | `/api/users/:id` | Yes | View profile; email is only returned to the account owner |
| `PUT` | `/api/users/:id` | Yes, self only | Update display name, email, avatar URL |
| `DELETE` | `/api/users/:id` | Yes, self only | Delete own account; requires current password in JSON body |
| `GET` | `/api/check-username/:name` | No | Check username availability |

### Register example

```http
POST /api/auth/register
Content-Type: application/json

{
  "username": "tripmate_user",
  "email": "user@example.com",
  "password": "at-least-8-chars",
  "display_name": "TripMate User"
}
```

### Login / logout examples

```json
POST /api/auth/login
{ "login": "tripmate_user", "password": "at-least-8-chars" }
```

Use the returned `token` as `Authorization: Bearer <token>`. Logout is `POST /api/auth/logout` with that header.

### Change password

```json
POST /api/auth/change-password
{ "current_password": "old-password", "new_password": "new-password-8+" }
```

After a password change, all existing sessions are revoked; login again to get a new token.

### Pagination response shape

`GET /api/users?page=2&limit=10&q=trip` returns `data` plus metadata like this:

```json
{
  "data": [],
  "pagination": {
    "page": 2, "limit": 10, "total": 0, "total_pages": 0,
    "has_previous": true, "has_next": false
  }
}
```

Invalid page/limit values return HTTP 400. `limit` cannot exceed 100. User list results do not expose email addresses. User editing/deletion is restricted to the authenticated account; deletion requires the current password because it permanently removes that account and related records.

## หน้าจัดการบัญชี (Frontend)

เปิด `tripmate-frontend/tripmate_frontend_api.html` แล้วเข้าสู่ระบบ จากเมนูด้านซ้ายเลือก **จัดการบัญชี** เพื่อ:

- แก้ไขชื่อที่แสดงและอีเมลของบัญชีตัวเอง
- เปลี่ยนรหัสผ่าน โดยต้องยืนยันรหัสผ่านปัจจุบัน (หลังเปลี่ยนระบบจะให้เข้าสู่ระบบใหม่)
- ค้นหารายชื่อผู้ใช้และเปลี่ยนหน้ารายการผ่าน `page`, `limit` และ `q`
- ลบบัญชีตัวเองโดยยืนยันรหัสผ่าน

รายการผู้ใช้แสดงเฉพาะ ID, ชื่อที่แสดง, username และวันที่สมัคร ไม่แสดงอีเมลของผู้ใช้อื่น
