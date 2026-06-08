# TODO - Image attachments in complaint feed

## Step 1: Backend upload wiring
- Update `routes/complaints.js` `POST /api/complaints` to accept multipart uploads using `middleware/upload.js`.
- Insert uploaded files into `attachments` table after creating the complaint.

## Step 2: Frontend send multipart
- Update `public/index.html` `submitComplaint()` to use `FormData`.
- Append images from `#cp-photos` with field name `photos`.

## Step 3: Feed UI thumbnail
- Update `renderCard(c)` in `public/index.html` to display the first attachment thumbnail (if any).

## Step 4: Verification
- Start server, submit a complaint with images, confirm images show in the feed and after refresh.

