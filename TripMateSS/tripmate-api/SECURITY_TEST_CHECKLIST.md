# TripMate security smoke-test checklist

Run these against the handoff/dev database only. Create two test accounts (Owner A and Member B) and a separate account that is not a trip member (User C). Do not use production credentials or data.

## Authentication
- [ ] `GET /api/me` without a Bearer token returns 401.
- [ ] Login with a wrong password returns 401 and does not issue a token.
- [ ] After `POST /api/auth/logout`, the same token is rejected by protected endpoints.
- [ ] Changing password revokes existing sessions; login again with the new password.
- [ ] Starting the API without `JWT_SECRET` or with a value shorter than 32 characters fails fast.

## User privacy and ownership
- [ ] `GET /api/users` requires authentication and directory results do not contain other users' email addresses.
- [ ] `GET /api/users/:id` does not expose email addresses.
- [ ] User B cannot `PUT` or `DELETE` User A's account (403).

## Trip access and roles
- [ ] User C cannot read a trip they do not belong to (404).
- [ ] A trip member whose status is not `joined` cannot access trip details.
- [ ] A joined member can read their trip.
- [ ] A non-owner cannot create/remove members, edit trip metadata, or delete the trip (403).
- [ ] A trip owner can manage members and trip metadata.

## Payments
- [ ] A member can record a payment for themselves.
- [ ] A member cannot submit `user_id` for another member (403).
- [ ] The trip owner can record a payment for a joined member.
- [ ] A payment cannot be recorded for a user who is not a joined member.
- [ ] A member cannot delete another member's payment; the trip owner can remove a payment for their trip.

## Data safety and compatibility
- [ ] `GET /health` returns `status: ok`.
- [ ] Login/register and the main frontend flows (trips, activities, accommodations, payments) still work.
- [ ] `docker compose down` may stop containers; do not use `docker compose down -v` or delete Docker volumes for routine testing.
- [ ] Back up the database before any schema/data migration. `db/init.sql` is only applied automatically when a new empty volume is initialized.

This checklist is a manual test plan, not evidence that every case has already passed.


## แนบสลิปการชำระเงิน
- [ ] บันทึกการชำระโดยไม่แนบสลิปได้ตามปกติ
- [ ] แนบ JPG/PNG/WEBP ที่ถูกต้อง ขนาดไม่เกิน 5 MB แล้วบันทึกได้
- [ ] ไฟล์เกิน 5 MB, PDF หรือไฟล์ปลอมที่เปลี่ยนนามสกุล ต้องถูกปฏิเสธ
- [ ] สมาชิกเห็น/เปิดสลิปของรายการตัวเองได้ แต่เปิดสลิปของสมาชิกคนอื่นไม่ได้
- [ ] เจ้าของทริปเปิดสลิปของสมาชิกในทริปได้
- [ ] ผู้ที่ไม่ได้เป็นสมาชิกทริปต้องเข้าถึงรายการและสลิปไม่ได้
- [ ] รีสตาร์ต container แล้วสลิปยังอยู่ใน Docker volume `payment_slips`
- [ ] ฐานข้อมูลเดิมมีคอลัมน์ `payments.slip_path` หลัง API เริ่มทำงาน โดยไม่มีการลบข้อมูลเดิม

## Authentication and user API regression checks

- [ ] Register a new user with valid `username`, `email`, `password` (8-128 chars), and `display_name`; expect `201` and a Bearer token.
- [ ] Register again with the same username or email; expect `409 DUPLICATE_USER`.
- [ ] Login with username and password, then repeat with email and password; expect `200` and a token for both.
- [ ] Login with an incorrect password; expect `401 INVALID_CREDENTIALS`.
- [ ] Call `GET /api/users?page=1&limit=10` with a token; confirm `data` and `pagination` (`page`, `limit`, `total`, `total_pages`, `has_previous`, `has_next`).
- [ ] Call `GET /api/users?page=0` or `?limit=101`; expect `400`.
- [ ] Call `GET /api/users?q=some-name&page=1&limit=10`; confirm search results and total are filtered consistently.
- [ ] Request another user's profile; confirm the email address is not returned.
- [ ] Try updating or deleting another user's ID; expect `403 FORBIDDEN`.
- [ ] Change password with the wrong current password; expect `400 WRONG_PASSWORD`.
- [ ] Change password with the correct current password; expect success, then confirm old token is rejected and new login succeeds.
- [ ] Logout; confirm the same token is rejected by a protected endpoint.
- [ ] Delete own account with no password or wrong password; expect `400`; only delete a disposable test account with the correct password.
