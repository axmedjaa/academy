# Afoogy — Google Stitch UI/UX Prompt Plan

## How to Use This File
This prompt plan follows the Google Stitch approach: start with a clear product concept, then iterate screen by screen with specific incremental prompts. Do not generate the entire application in one prompt.

## 1. Project Foundation Prompt
```text
Design a modern, simple, premium web application called Afoogy.

Afoogy is a Skill Academy Management System for training centers and academies that teach professional and practical skills. It helps academy staff manage students, programs, courses, batches, attendance, manual payment records, certificates, staff, notifications, and reports.

This is not a traditional school system and not an LMS. Design it as a clean B2B SaaS management platform for busy academy managers and staff.

The primary design goal is simplicity. Users should immediately understand what to do without training. Keep workflows practical and avoid complex enterprise-style interfaces.

Use a modern, trustworthy, organized, and professional visual style. The main brand color is professional blue (#2563EB). The interface should mostly use white, soft gray (#F8FAFC), subtle borders (#E2E8F0), dark text (#0F172A), and muted secondary text (#64748B).

Create a desktop-first dashboard with a clean left sidebar, simple top header, and spacious main content area. Use modern sans-serif typography, subtle border radius, minimal shadows, clear data tables, simple forms, and accessible contrast.

Avoid excessive charts, gradients, colors, tabs, filters, and decorative elements.

Main navigation: Dashboard, Students, Programs, Courses, Batches, Attendance, Payments, Certificates, Staff, Reports, Notifications, Settings.
```

## 2. Global UI/UX Direction
- Professional, calm, trustworthy, modern, simple, organized.
- Powerful internally, simple externally.
- One clear primary action per page.
- Blue for primary actions and active states.
- White and soft gray dominate the interface.
- Generous whitespace, subtle borders, minimal shadows.
- Prefer progressive disclosure over showing everything at once.
- Keep forms short and tables readable.

## 3. Design System Prompt
```text
Refine the Afoogy design system. Keep the existing product concept, but create a more consistent premium SaaS interface.

Use professional blue (#2563EB) for primary actions and active states. Keep most surfaces white and light gray. Use subtle borders, minimal shadows, medium border radius, and modern sans-serif typography.

Create consistent components for primary buttons, secondary buttons, outline buttons, input fields, search bars, select menus, status badges, data tables, statistic cards, empty states, confirmation dialogs, success messages, dropdown menus, and pagination.

Keep all components simple and consistent. Do not make the UI overly rounded or playful.
```

## 4. Dashboard Prompt
```text
Design the Afoogy Dashboard as the first page after login.

The dashboard should help an academy manager understand what is happening today without overwhelming them.

Title: Dashboard
Subtitle: Overview of your academy performance.

At the top, create five simple statistic cards:
Total Students,
Active Batches,
Monthly Payments,
Outstanding Fees,
Certificates Issued.

Below, create a balanced two-column layout.

Left: Recent Payments table with Student, Amount, Date, Status.
Right: Requires Attention with a maximum of five alerts such as outstanding fees, pending certificates, low attendance, or upcoming batches.

Below this, add an Active Batches table with Batch, Course, Trainer, Students, Status.

Include only one simple Revenue Overview chart near the bottom.

The dashboard should feel calm, useful, and easy to scan in less than 10 seconds.
```

## 5. Students List Prompt
```text
Design the Students page for Afoogy.

Header:
Title: Students
Subtitle: Manage all academy students.
Primary action: + Add Student

Add a clean search bar: Search students by name, phone, or ID...

Use only simple filters: All Students, Active, Completed, Inactive.

Create a readable table:
Student, Student ID, Program, Batch, Phone, Payment Status, Status, Actions.

Actions: View Profile, Edit, Record Payment.

Do not overcrowd the page with analytics or unnecessary filters.
```

## 6. Add Student Prompt
```text
Design a simple Add Student form for Afoogy.

Personal Information:
Full Name, Phone Number, Email, Gender, Date of Birth, Address.

Enrollment Information:
Program, Course, Batch, Enrollment Date.

Primary button: Create Student
Secondary button: Cancel

Keep the form short and easy for academy staff.
```

## 7. Student Profile Prompt
```text
Design a clean Student Profile page for Afoogy.

At the top show avatar, full name, student ID, and status.
Actions: Edit Student and Record Payment.

Organize information into four simple sections:
Personal Information,
Current Enrollment,
Payment Summary,
Attendance.

Payment Summary shows Total Fee, Amount Paid, Remaining Balance.
Attendance shows overall percentage.

At the bottom show concise Recent Payments, Recent Attendance, and Certificates.

Important information should be visible without excessive clicking.
```

## 8. Programs Prompt
```text
Design the Programs page for Afoogy.

Header: Programs
Primary action: + Create Program

Use clean cards or a simple table. Each program shows Program Name, Short Description, Number of Courses, Students, Batches, and Status.

Keep the layout spacious and simple.
```

## 9. Courses Prompt
```text
Design the Courses page for Afoogy.

Header: Courses
Primary action: + Add Course

Table:
Course, Program, Duration, Fee, Students, Status, Actions.

Make it practical and easy for administrative staff.
```

## 10. Batches Prompt
```text
Design the Batches page for Afoogy.

Header: Batches
Primary action: + Create Batch

Show three small summary cards: Active Batches, Upcoming, Completed.

Table:
Batch Name, Course, Trainer, Students, Schedule, Status, Actions.

Keep the interface focused on managing training groups.
```

## 11. Create Batch Prompt
```text
Design a simple Create Batch form for Afoogy.

Fields:
Batch Name, Course, Trainer, Start Date, End Date, Maximum Students, Schedule.

Primary button: Create Batch
Secondary button: Cancel
```

## 12. Batch Details Prompt
```text
Design a Batch Details page for Afoogy.

Show Batch Name, Status, Course, Trainer, Start Date, End Date, Student Count, Schedule.

Below organize simple sections:
Students,
Attendance Summary,
Recent Payment Status.

Do not overload the page with analytics.
```

## 13. Attendance Prompt
```text
Design the Attendance page for Afoogy.

The primary goal is speed.

At the top:
Select Batch,
Select Date,
Load Students button.

After selecting a batch, display a clean student list.

For each student provide:
Present,
Absent,
Late.

Show a small summary of Present, Absent, and Late counts.

Primary action: Save Attendance.

A trainer should complete attendance in less than one minute.
```

## 14. Payments Prompt
```text
Design the Payments page for Afoogy.

Important: Payments are manually recorded. This is not a complicated online payment processing interface.

Header:
Title: Payments
Subtitle: Record and track student payments.
Primary action: + Record Payment

Show four summary cards:
Total Collected,
This Month,
Outstanding Fees,
Today's Payments.

Table:
Student, Amount, Payment Method, Date, Recorded By, Status, Actions.

Keep the page professional but very simple.
```

## 15. Record Payment Prompt
```text
Design the Record Payment workflow for Afoogy.

First provide a searchable student selector.

After selecting a student display:
Student Name,
Course,
Total Fee,
Already Paid,
Remaining Balance.

Payment fields:
Amount Paid,
Payment Method,
Payment Date,
Notes.

Methods:
Cash,
Bank Transfer,
Mobile Money,
Other.

Primary action: Record Payment.

After success show:
Payment Recorded Successfully,
Amount,
Student,
Remaining Balance.

Actions:
View Receipt,
Record Another Payment.

Avoid complicated accounting terminology.
```

## 16. Outstanding Fees Prompt
```text
Design the Outstanding Fees page for Afoogy.

Table:
Student, Course, Total Fee, Paid, Remaining, Status, Action.

Main action: Record Payment.

Use clear status badges:
Paid,
Partial,
Outstanding,
Overdue.
```

## 17. Certificates Prompt
```text
Design the Certificates page for Afoogy.

Header: Certificates
Primary action: + Issue Certificate

Show statistics:
Pending,
Issued,
This Month,
Total Certificates.

Table:
Student, Course, Issue Date, Certificate Number, Status, Actions.

The design should feel official and trustworthy.
```

## 18. Issue Certificate Prompt
```text
Design a simple certificate issuing workflow for Afoogy.

Search and select a student.

Then display:
Student,
Course,
Batch,
Completion Status.

Primary action: Issue Certificate.

Show a confirmation dialog before issuing.

After issuance show Certificate Number and Issued Status.

Actions:
View,
Download,
Print.
```

## 19. Certificate Verification Prompt
```text
Design a simple public Certificate Verification page for Afoogy.

Use a clean centered layout with Afoogy branding.

Title: Verify Certificate
Subtitle: Enter the certificate number to verify its authenticity.

Include Certificate Number input and Verify Certificate button.

For a successful result show:
Verified status,
Student Name,
Course,
Academy,
Issue Date,
Certificate Number.

Make it official, trustworthy, and minimal.
```

## 20. Staff Prompt
```text
Design the Staff page for Afoogy.

Header: Staff
Primary action: + Add Staff

Table:
Staff Member,
Role,
Phone,
Assigned Batches,
Status,
Actions.

Roles:
Owner,
Manager,
Trainer,
Finance Staff,
Admissions Staff.

Keep staff management simple. Avoid a complicated enterprise permission matrix in the first version.
```

## 21. Reports Prompt
```text
Design the Reports page for Afoogy.

Create four simple report sections:
Student Reports,
Financial Reports,
Attendance Reports,
Certificate Reports.

Student: Total Students, New Students, Active Students, Completed Students.
Financial: Total Collected, Outstanding Fees, Monthly Revenue, one simple chart.
Attendance: Overall Attendance, Best Performing Batch, Low Attendance Students.
Certificates: Certificates Issued, Pending Certificates.

Include a simple date filter and Export Report action.

Do not turn this into a complicated business intelligence dashboard.
```

## 22. Notifications Prompt
```text
Design the Notifications page and notification center for Afoogy.

Use a simple chronological list.

Examples:
Ahmed Ali payment was recorded.
A new student was registered.
A certificate is pending.
12 students have outstanding fees.

Each notification shows Icon, Message, Time, and Read/Unread state.

The notification bell opens a compact dropdown with recent notifications and a View All action.
```

## 23. Settings Prompt
```text
Design a simple Settings page for Afoogy.

Left navigation:
Academy Profile,
Staff,
Payment Settings,
Certificate Settings,
Notifications,
Account.

Academy Profile fields:
Academy Name,
Logo,
Phone,
Email,
Address.

Use clear Save Changes buttons.
Avoid technical configuration screens.
```

## 24. Empty States Prompt
```text
Create consistent empty states across Afoogy.

Example:
Title: No Students Yet
Description: Start building your academy records by adding your first student.
Primary action: + Add Student

Create similar empty states for Programs, Courses, Batches, Payments, Certificates, and Notifications.

Use minimal illustrations or simple icons. Keep them professional, not childish.
```

## 25. Final Consistency Review Prompt
```text
Review the entire Afoogy application for UI and UX consistency.

Ensure navigation, spacing, typography, buttons, forms, tables, status badges, and cards follow consistent patterns.

Simplify any screen that feels crowded or enterprise-heavy. Remove unnecessary charts, filters, tabs, and controls.

Prioritize daily workflows:
adding students,
viewing students,
creating batches,
taking attendance,
recording manual payments,
checking outstanding balances,
issuing certificates,
viewing reports.

The final product should feel like a premium modern SaaS application that is powerful enough for academy management but simple enough to understand immediately.
```

## Recommended Stitch Workflow

1. Generate Project Foundation.
2. Refine the Design System.
3. Generate Dashboard.
4. Refine Dashboard before moving on.
5. Generate Students List and Student Profile.
6. Generate Programs, Courses, and Batches.
7. Generate Attendance.
8. Generate Payments and Record Payment workflow.
9. Generate Certificates and Verification.
10. Generate Staff.
11. Generate Reports.
12. Generate Notifications and Settings.
13. Run Final Consistency Review.

**Rule:** One major screen or workflow at a time. Iterate with specific prompts rather than generating the entire product at once.
