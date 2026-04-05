

### **Google Maps Review Checker: Setup Guide for Beginners**

### **1. Introduction**
This project is a tool designed to verify the status of review links on Google Maps. It utilizes **Playwright** for browser automation and integrates with **Google Sheets** for data reading and writing.

### **2. Prerequisites**
Before starting, ensure your computer has the following installed:
* **Node.js**: Version 14 or higher (The latest LTS version is recommended).
* **Browser**: Google Chrome or Microsoft Edge.

### **3. Detailed Installation Steps**

#### **Step 1: Download Source Code and Install Dependencies**
1.  Extract the project folder.
2.  Open your terminal (Command Prompt on Windows or Terminal on Mac/Linux) and navigate to the project directory.
3.  Run the following command to install the required libraries:
    ```bash
    npm install
    ```
4.  Install the necessary browsers for the automation tool (Playwright):
    ```bash
    npx playwright install chromium
    ```

#### **Step 2: Configure Environment Variables (`.env`)**
The project requires specific configuration details to operate:
1.  Locate the file named `.env.example` in the root directory.
2.  Rename it to `.env`.
3.  Open the `.env` file with a text editor (like Notepad or VS Code) and fill in the required information, such as the `PORT` (default is usually 3000).

#### **Step 3: Google Sheets Configuration (Optional)**
The project uses `sheetsClient.js` to connect to Google Sheets.
1.  You need a `credentials.json` file from the Google Cloud Console (Service Account).
2.  Ensure the `credentials.json` file is placed in the root directory of the project.
3.  Provide your Google Sheet ID in your configuration settings.

#### **Step 4: Proxy Configuration (Optional)**
If you have a list of proxies to prevent being blocked by Google, enter the information into the `proxies.json` file.

### **4. How to Run the Program**

This project includes an Express web server and a control interface.

1.  **Start the Server:** In the terminal, run:
    ```bash
    npm start
    ```
    Or:
    ```bash
    node server.js
    ```

2.  **Access the Interface:** Once the server is running (typically on port 3000), open your browser and go to:
    `http://localhost:3000`

3.  **Using Windows:** You can also double-click the `start.bat` file, which is designed to automate the startup process.
