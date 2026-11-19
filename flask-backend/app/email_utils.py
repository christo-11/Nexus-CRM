import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from datetime import datetime

def send_crm_email(recipient_email, subject, alert_message):
    """
    Sends an automated email notification for CRM workflows.
    """
    smtp_server = 'smtp.gmail.com'
    smtp_port = 587
    sender_email = os.getenv('MAIL_USERNAME', 'soorajnadarajan2005@gmail.com')
    sender_password = os.getenv('MAIL_PASSWORD', 'kjqooqjrgaazezjl')

    try:
        msg = MIMEMultipart()
        msg['From'] = sender_email
        msg['To'] = recipient_email
        msg['Subject'] = subject

        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        body = f"""
        CRM AUTOMATION NOTIFICATION

        Time: {timestamp}
        
        Details:
        {alert_message}

        ---
        This is an automated message from your CRM System.
        """
        msg.attach(MIMEText(body, 'plain'))

        server = smtplib.SMTP(smtp_server, smtp_port)
        server.starttls()
        server.login(sender_email, sender_password)
        text = msg.as_string()
        server.sendmail(sender_email, recipient_email, text)
        server.quit()
        
        print(f"CRM Email sent successfully to {recipient_email} at {timestamp}")
        return True
        
    except Exception as e:
        print(f"Failed to send CRM email: {e}")
        return False