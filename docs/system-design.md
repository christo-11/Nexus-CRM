# System design

## Component view

```mermaid
flowchart TB
    subgraph Client
        UI[React SPA]
        JWT[JWT access and rotating refresh tokens]
        UI --- JWT
    end
    subgraph Edge
        NGINX[Nginx reverse proxy]
    end
    subgraph Application
        REST[Flask REST API]
        WS[Flask-SocketIO]
        ORM[SQLAlchemy]
    end
    subgraph Data
        MYSQL[(MySQL)]
        UPLOADS[(Private upload volume)]
    end
    SMTP[Gmail SMTP]
    JITSI[Public Jitsi Meet]

    UI -->|HTTPS REST| NGINX
    UI <-->|Socket.IO notifications| NGINX
    NGINX --> REST
    NGINX --> WS
    REST --> ORM
    WS --> ORM
    ORM --> MYSQL
    REST --> UPLOADS
    REST --> SMTP
    REST -->|Persist generated meeting URL| MYSQL
    UI -->|Customer and staff meeting| JITSI
```

## Entity relationship view

```mermaid
erDiagram
    ROLE ||--o{ USER : grants
    DEPARTMENT o|--o{ USER : groups
    USER ||--o{ TICKET : creates
    USER o|--o{ TICKET : assigned
    DEPARTMENT ||--o{ TICKET : owns
    PRODUCT o|--o{ TICKET : concerns
    PRODUCT o|--o{ LEAD : interests
    USER ||--o{ LEAD : owns
    USER ||--o{ LEAD : creates
    USER o|--o{ LEAD : converts
    USER o|--o{ ENQUIRY : submits
    LEAD ||--o{ ENQUIRY : records
    PRODUCT o|--o{ ENQUIRY : concerns
    TICKET o|--o| LEAD : conversion
    TICKET ||--o{ TICKET_COMMENT : has
    USER ||--o{ TICKET_COMMENT : writes
    TICKET ||--o{ TICKET_DOCUMENT : attaches
    USER ||--o{ TICKET_DOCUMENT : uploads
    TICKET ||--o{ MEETING : schedules
    USER ||--o{ MEETING : creates
    USER ||--o{ NOTIFICATION : receives
    TICKET o|--o{ NOTIFICATION : relates
    USER o|--o{ ACTIVITY_LOG : performs
    USER o|--o{ AUDIT_LOG : performs

    ROLE {
        int id PK
        string name UK
    }
    DEPARTMENT {
        int id PK
        string name UK
        string slug UK
    }
    USER {
        int id PK
        string public_id UK
        string email UK
        string password_hash
        int role_id FK
        int department_id FK
        boolean is_active
        datetime email_verified_at
    }
    PRODUCT {
        int id PK
        string name
        string category
        decimal price
        string status
    }
    TICKET {
        int id PK
        string ticket_number UK
        int customer_id FK
        int product_id FK
        int department_id FK
        int assignee_id FK
        string issue_category
        string priority
        string status
        datetime created_at
    }
    LEAD {
        int id PK
        string email
        string dedupe_key UK
        int product_id FK
        int customer_id FK
        int assigned_to_id FK
        int created_by_id FK
        int converted_customer_id FK
        int converted_ticket_id FK
        string status
        datetime created_at
    }
    ENQUIRY {
        int id PK
        int lead_id FK
        int customer_id FK
        int product_id FK
        string type
        text message
        datetime created_at
    }
    TICKET_COMMENT {
        int id PK
        int ticket_id FK
        int author_id FK
        boolean is_internal
    }
    TICKET_DOCUMENT {
        int id PK
        int ticket_id FK
        int uploaded_by_id FK
        string stored_name UK
    }
    MEETING {
        int id PK
        int ticket_id FK
        datetime starts_at
        string jitsi_url
        int created_by_id FK
    }
    NOTIFICATION {
        int id PK
        int recipient_id FK
        int ticket_id FK
        string kind
        datetime read_at
    }
    ACTIVITY_LOG {
        int id PK
        int actor_id FK
        string action
        string object_type
        string object_id
    }
    AUDIT_LOG {
        int id PK
        int actor_id FK
        string action
        string object_type
        string object_id
        json details
        string ip_address
    }
    REVOKED_TOKEN {
        string jti PK
        datetime revoked_at
    }
```

## Authorization and routing

- Public registration always creates a Customer. The first Main Admin is created only by the `flask seed` command with explicit admin environment variables. The web UI cannot grant the Main Admin role.
- Customers can see only their own tickets and non-internal comments. Staff can see tickets in their own department or explicitly assigned to them. Main Admin can read ticket overviews and details, but ticket conversations, attachments, and updates remain restricted to customers and assigned staff.
- A ticket's issue category selects the default department. Critical priority on creation routes the ticket to the Main Admin queue and sends a status-only in-app and Socket.IO alert. Product Maintenance can update and resolve defect tickets directly; changing a ticket's priority does not reroute it.
- SQLAlchemy query construction is used for database access; request text is never interpolated into SQL.
- Sales enquiries deduplicate active leads using a unique hash of the normalized email; each submission remains a separate enquiry-history row. Conversion transactionally links that history to the customer. Signed-in support requests create routed tickets directly and do not enter the lead pipeline.
- Uploaded files use generated storage names and are only downloadable after the caller passes the ticket visibility check.

## Operational boundaries

- REST and Socket.IO run in a single Gunicorn worker in the provided configuration so in-process Socket.IO rooms remain consistent. For multiple API instances, configure a shared Socket.IO message queue and shared durable upload storage before scaling.
- Alembic is the production schema authority. `init-db`/`db.create_all()` is only a local development convenience; production uses `flask db upgrade`.
- SMTP and public Jitsi depend on third-party account limits and availability. The API includes an `email_sent` result for notification-triggering operations; local debug returns links for testing.
- SQLite is for a single-user developer instance. Production uses MySQL with backups and TLS-protected network access.
