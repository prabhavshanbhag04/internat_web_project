# File Management System with Version Control

A web-based file management system that prevents accidental file overwrites by maintaining multiple versions of uploaded files with complete change history.

## Features

- User authentication (signup/login)
- User profile management with password change
- Upload files with automatic version tracking
- View all versions of each file
- Download any previous version
- Activity log showing all file operations
- Clean, responsive web interface
- Session-based authentication
- Password hashing with bcrypt

## Installation

1. Install dependencies:
```
npm install
```

2. Start the server:
```
npm start
```

3. Open browser and navigate to:
```
http://localhost:3000
```

4. Create an account by clicking "Sign up"
5. Login with your credentials

## How It Works

- **User Authentication**: Secure signup/login with password hashing
- **User Profiles**: Update name, email, and password
- **Version Control**: Each time you upload a file with the same name, a new version is created
- **Metadata Storage**: File information stored in `metadata.json`
- **User Data**: User accounts stored in `users.json`
- **Activity Logging**: All operations logged in `activity.log`
- **File Storage**: Physical files stored in `uploads/` directory
- **Sessions**: Express-session for maintaining user sessions

## Project Structure

```
├── server.js           # Main server file
├── package.json        # Dependencies
├── views/
│   ├── index.ejs      # Main dashboard
│   ├── login.ejs      # Login page
│   ├── signup.ejs     # Signup page
│   └── profile.ejs    # User profile page
├── public/
│   ├── style.css      # Main styling
│   ├── auth.css       # Authentication styling
│   └── script.js      # Client-side JavaScript
├── uploads/           # Uploaded files (created automatically)
├── metadata.json      # File version metadata (created automatically)
├── users.json         # User accounts (created automatically)
└── activity.log       # Activity log (created automatically)
```

## Usage

1. Sign up for a new account or login
2. Click "Choose File" and select a file to upload
3. Click "Upload" to save the file
4. Upload the same file again to create a new version
5. Click "View Versions" to see all versions of a file
6. Click "Download" to retrieve any version
7. Click "Load Activity" to view the activity log
8. Click "Profile" to update your account information
9. Click "Logout" to end your session
