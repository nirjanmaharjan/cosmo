# TODO

- [x] Add admin backend APIs for student CRUD in `routes/admin.js`:

  - [x] `PUT /api/admin/students/:id` update fields (name, roll_number, class_name, section, degree_faculty, email)

  - [x] `POST /api/admin/students` create a student (email, password, name, roll_number, class_name, section, degree_faculty)

  - [x] `DELETE /api/admin/students/:id` remove student

- [x] Update admin frontend `public/index.html` Student List page:

  - [ ] Add Edit button + modal per student and save via `PUT`
  - [ ] Add Add Student form and submit via `POST`
  - [ ] Add Remove button + confirmation and delete via `DELETE`
- [x] Refresh list and dropdown filters after create/update/delete

- [ ] Manual testing:
  - [ ] Login as admin, navigate to Student List, verify list + filters + search
  - [ ] Edit student info updates UI
  - [ ] Add student appears in list
  - [ ] Remove student disappears from list

