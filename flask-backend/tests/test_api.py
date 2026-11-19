import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

from sqlalchemy.exc import SQLAlchemyError

from app import ai_support, create_app, normalize_database_url
from app.extensions import db, limiter
from app.models import (
    Department,
    Enquiry,
    FeedbackReview,
    Lead,
    Meeting,
    Notification,
    ProductInterestEvent,
    Product,
    Role,
    Ticket,
    TicketComment,
    User,
)
from app.services import (
    _ticket_email_content,
    queue_crm_email,
    sales_assignment_email_content,
    sales_enquiry_email_content,
    send_user_email,
)


class SmartCRMApiTests(unittest.TestCase):
    def test_non_test_app_requires_supabase_database(self):
        with self.assertRaisesRegex(RuntimeError, "requires the configured Supabase"):
            create_app({
                "TESTING": False,
                "DEBUG": True,
                "SQLALCHEMY_DATABASE_URI": "sqlite:///not-used.sqlite3",
            })

    def test_supabase_postgres_url_uses_psycopg_and_tls(self):
        normalized = normalize_database_url(
            "postgresql://postgres.example:[ENCODED-PASSWORD]"
            "@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres"
        )
        self.assertTrue(normalized.startswith("postgresql+psycopg://"))
        self.assertTrue(normalized.endswith("/postgres?sslmode=require"))

    def test_supabase_postgres_url_preserves_explicit_sslmode(self):
        normalized = normalize_database_url(
            "postgres://user:password@db.example.com/postgres?sslmode=verify-full"
        )
        self.assertTrue(normalized.startswith("postgresql+psycopg://"))
        self.assertTrue(normalized.endswith("/postgres?sslmode=verify-full"))

    def test_frontend_url_is_allowed_when_cors_origins_is_configured(self):
        frontend_url = "http://127.0.0.1:5173"
        with patch.dict("os.environ", {"CORS_ORIGINS": "http://localhost:8080"}):
            app = create_app({
                "TESTING": True,
                "SQLALCHEMY_DATABASE_URI": "sqlite://",
                "FRONTEND_URL": frontend_url,
                "UPLOAD_FOLDER": "instance/test-uploads",
            })

        response = app.test_client().get(
            "/api/v1/health",
            headers={"Origin": frontend_url},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.headers.get("Access-Control-Allow-Origin"),
            frontend_url,
        )

    def test_api_root_returns_service_links(self):
        response = self.client.get("/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {
            "name": "NEXUS CRM API",
            "status": "ok",
            "frontend": "http://127.0.0.1:5173/login",
            "health": "/api/v1/health",
        })

    def setUp(self):
        self.app = create_app({
            "TESTING": True,
            "DEBUG": True,
            "SECRET_KEY": "test-secret-key-with-at-least-32-bytes",
            "JWT_SECRET_KEY": "test-jwt-secret-with-at-least-32-bytes",
            "SQLALCHEMY_DATABASE_URI": "sqlite://",
            "UPLOAD_FOLDER": "instance/test-uploads",
            "MAIL_SUPPRESS_SEND": True,
            "MAIL_DEFAULT_SENDER": "test@example.com",
        })
        limiter.reset()
        self.context = self.app.app_context()
        self.context.push()
        db.create_all()
        self.client = self.app.test_client()
        for name in ("CUSTOMER", "SALES_MANAGER", "PRODUCT_MAINTENANCE", "SUPPORT", "MAIN_ADMIN"):
            db.session.add(Role(name=name))
        for name, slug in (
            ("Sales", "sales"),
            ("Product Maintenance", "product-maintenance"),
            ("Support", "support"),
            ("Main Admin", "main-admin"),
        ):
            db.session.add(Department(name=name, slug=slug))
        db.session.flush()
        self.admin = self.create_user("Admin", "admin@example.com", "MAIN_ADMIN", "main-admin")
        self.sales = self.create_user("Sales", "sales@example.com", "SALES_MANAGER", "sales")
        self.maintenance = self.create_user("Maintenance", "maintenance@example.com", "PRODUCT_MAINTENANCE", "product-maintenance")
        self.support = self.create_user("Support", "support@example.com", "SUPPORT", "support")
        self.customer = self.create_user("Customer", "customer@example.com", "CUSTOMER", None)
        self.product = Product(name="CRM Suite", category="Software", description="CRM tools", price=10, status="ACTIVE")
        db.session.add(self.product)
        db.session.commit()

    def tearDown(self):
        db.session.remove()
        db.drop_all()
        self.context.pop()

    def create_user(self, name, email, role, department_slug):
        department = Department.query.filter_by(slug=department_slug).first() if department_slug else None
        user = User(
            name=name,
            email=email,
            role=Role.query.filter_by(name=role).one(),
            department=department,
            email_verified_at=datetime.now(timezone.utc),
        )
        user.set_password("Valid-Crm-Password-123")
        db.session.add(user)
        db.session.flush()
        return user

    def auth(self, email, password="Valid-Crm-Password-123"):
        response = self.client.post("/api/v1/auth/login", json={"email": email, "password": password})
        self.assertEqual(response.status_code, 200, response.get_json())
        return {"Authorization": f"Bearer {response.get_json()['access']}"}

    def create_ticket(self, headers, category, priority="MEDIUM"):
        return self.client.post(
            "/api/v1/tickets",
            headers=headers,
            json={
                "issue_category": category,
                "priority": priority,
                "subject": "A valid test subject",
                "description": "A detailed issue description.",
                "product_id": self.product.id,
            },
        )

    def test_ai_support_retrieves_sources_and_returns_a_grounded_answer(self):
        headers = self.auth("customer@example.com")
        chat_request = {}

        def ollama_response(method, path, payload=None, timeout=60):
            if path == "/api/embed":
                return {"embeddings": [[1.0, 0.0] for _ in payload["input"]]}
            if path == "/api/chat":
                chat_request.update(payload)
                return {"message": {"content": '{"answer":"Create a support ticket in the customer portal.","source_ids":["S1"]}'}}
            self.fail(f"Unexpected Ollama endpoint: {path}")

        with (
            patch("app.ai_support._INDEX_CACHE", None),
            patch("app.ai_support._knowledge_documents", return_value=[
                ("Support FAQ", "Create a support ticket in the customer portal to contact support.")
            ]),
            patch("app.ai_support.ollama_request", side_effect=ollama_response),
        ):
            response = self.client.post(
                "/api/v1/ai-support/chat",
                headers=headers,
                json={"message": "How can I contact support?", "history": []},
            )

        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(response.get_json()["answer"], "Create a support ticket in the customer portal.")
        self.assertEqual(response.get_json()["sources"][0]["title"], "Support FAQ")
        self.assertFalse(response.get_json()["needs_human_support"])
        self.assertIn("Approved support excerpts:", chat_request["messages"][1]["content"])
        self.assertEqual(chat_request["keep_alive"], "15m")
        self.assertEqual(chat_request["options"]["temperature"], 0)
        self.assertEqual(chat_request["options"]["num_predict"], 256)

    def test_ai_support_answers_how_to_create_a_lead_from_faq(self):
        headers = self.auth("sales@example.com")
        faq = next(
            (title, content)
            for title, content in ai_support._knowledge_documents()
            if title == "support_faq.md"
        )
        chat_request = {}

        def ollama_response(method, path, payload=None, timeout=60):
            if path == "/api/embed":
                return {"embeddings": [[1.0, 0.0] for _ in payload["input"]]}
            if path == "/api/chat":
                chat_request.update(payload)
                return {"message": {"content": (
                    '{"answer":"Open Leads & pipeline, select Add lead, enter the required '
                    'contact name and work email, then select Create lead.","source_ids":["S1"]}'
                )}}
            self.fail(f"Unexpected Ollama endpoint: {path}")

        with (
            patch("app.ai_support._INDEX_CACHE", None),
            patch("app.ai_support._knowledge_documents", return_value=[faq]),
            patch("app.ai_support.ollama_request", side_effect=ollama_response),
        ):
            response = self.client.post(
                "/api/v1/ai-support/chat",
                headers=headers,
                json={"message": "How do I create a lead?", "history": []},
            )

        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertFalse(response.get_json()["needs_human_support"])
        self.assertEqual(response.get_json()["sources"][0]["title"], "support_faq.md")
        self.assertIn("Sales Manager or Main Admin", chat_request["messages"][1]["content"])
        self.assertIn("Add lead** and enter", chat_request["messages"][1]["content"])
        self.assertIn("work email", chat_request["messages"][1]["content"])

    def test_ai_support_indexes_only_active_product_information(self):
        inactive = Product(
            name="Retired Product",
            category="Legacy",
            description="Do not include this product.",
            price=0,
            status="INACTIVE",
        )
        db.session.add(inactive)
        db.session.commit()

        documents = ai_support._knowledge_documents()

        self.assertTrue(any(
            title == "Product: CRM Suite" and "CRM tools" in content
            for title, content in documents
        ))
        self.assertFalse(any(title == "Product: Retired Product" for title, _ in documents))

    def test_ai_support_unknown_question_offers_human_support_without_generating(self):
        headers = self.auth("customer@example.com")
        embedding_count = 0

        def ollama_response(_method, path, payload=None, timeout=60):
            nonlocal embedding_count
            self.assertEqual(path, "/api/embed")
            embedding_count += 1
            return {"embeddings": [[1.0, 0.0] if embedding_count == 1 else [0.0, 1.0]]}

        with (
            patch("app.ai_support._INDEX_CACHE", None),
            patch("app.ai_support._knowledge_documents", return_value=[
                ("Support FAQ", "Support tickets are created in the customer portal.")
            ]),
            patch("app.ai_support.ollama_request", side_effect=ollama_response),
        ):
            response = self.client.post(
                "/api/v1/ai-support/chat",
                headers=headers,
                json={"message": "What is the weather on Mars?", "history": []},
            )

        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertTrue(response.get_json()["needs_human_support"])
        self.assertEqual(response.get_json()["sources"], [])
        self.assertEqual(embedding_count, 2)

    def test_ai_support_rejects_unrelated_sources_even_if_embedding_score_is_high(self):
        headers = self.auth("customer@example.com")
        with (
            patch("app.ai_support._build_index", return_value=[
                ("Support FAQ", "Create a support ticket in the customer portal.", [1.0, 0.0])
            ]),
            patch("app.ai_support._embedding", return_value=[[0.48, 0.877]]),
            patch("app.ai_support.ollama_request") as ollama_request,
        ):
            response = self.client.post(
                "/api/v1/ai-support/chat",
                headers=headers,
                json={"message": "What is the weather on Mars tomorrow?", "history": []},
            )

        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertTrue(response.get_json()["needs_human_support"])
        self.assertEqual(response.get_json()["sources"], [])
        ollama_request.assert_not_called()

    def test_ai_support_treats_explicit_model_abstention_as_handoff(self):
        headers = self.auth("customer@example.com")
        with (
            patch("app.ai_support._build_index", return_value=[
                ("Support FAQ", "Create a support ticket in the customer portal.", [1.0, 0.0])
            ]),
            patch("app.ai_support._embedding", return_value=[[1.0, 0.0]]),
            patch("app.ai_support.ollama_request", return_value={
                "message": {"content": '{"answer":"Not available","source_ids":["S1"]}'}
            }),
        ):
            response = self.client.post(
                "/api/v1/ai-support/chat",
                headers=headers,
                json={"message": "How do I contact support?", "history": []},
            )

        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertTrue(response.get_json()["needs_human_support"])
        self.assertEqual(response.get_json()["sources"], [])

    def test_ai_support_ollama_failure_returns_service_unavailable(self):
        headers = self.auth("customer@example.com")

        with (
            patch("app.ai_support._INDEX_CACHE", None),
            patch("app.ai_support._knowledge_documents", return_value=[
                ("Support FAQ", "Contact support through the customer portal.")
            ]),
            patch("app.ai_support.ollama_request", side_effect=ai_support.OllamaUnavailable()),
        ):
            response = self.client.post(
                "/api/v1/ai-support/chat",
                headers=headers,
                json={"message": "How do I contact support?", "history": []},
            )

        self.assertEqual(response.status_code, 503)
        self.assertIn("temporarily unavailable", response.get_json()["error"])

    def test_ai_support_health_reports_missing_models_without_exposing_configuration(self):
        headers = self.auth("customer@example.com")

        with patch("app.api.ollama_models_available", return_value=False):
            response = self.client.get("/api/v1/ai-support/health", headers=headers)

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.get_json()["status"], "models_missing")
        self.assertNotIn("model", response.get_json())
        self.assertNotIn("base_url", response.get_json())

    def test_ai_support_accepts_ollama_latest_tag_for_default_embedding_model(self):
        with patch("app.ai_support.ollama_request", return_value={
            "models": [
                {"name": "llama3.2:3b"},
                {"name": "nomic-embed-text:latest"},
            ],
        }):
            available = ai_support.ollama_models_available()

        self.assertTrue(available)

    def test_ai_support_health_reports_background_warmup(self):
        headers = self.auth("customer@example.com")
        with (
            patch("app.api.ollama_models_available", return_value=True),
            patch("app.api.warmup_status", return_value="warming"),
        ):
            response = self.client.get("/api/v1/ai-support/health", headers=headers)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["status"], "warming")

    def test_ai_support_with_empty_knowledge_base_offers_human_support(self):
        headers = self.auth("customer@example.com")

        with (
            patch("app.ai_support._INDEX_CACHE", None),
            patch("app.ai_support._knowledge_documents", return_value=[]),
            patch("app.ai_support.ollama_request") as ollama_request,
        ):
            response = self.client.post(
                "/api/v1/ai-support/chat",
                headers=headers,
                json={"message": "How can I get support?", "history": []},
            )

        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertTrue(response.get_json()["needs_human_support"])
        self.assertEqual(response.get_json()["sources"], [])
        ollama_request.assert_not_called()

    def test_ai_support_human_escalation_uses_existing_customer_ticket_routing(self):
        headers = self.auth("customer@example.com")

        response = self.create_ticket(headers, "TECHNICAL_SUPPORT")

        self.assertEqual(response.status_code, 201, response.get_json())
        ticket_data = response.get_json()["ticket"]
        ticket = db.session.get(Ticket, ticket_data["id"])
        self.assertEqual(ticket.customer_id, self.customer.id)
        self.assertEqual(ticket.department.name, "Support")
        self.assertTrue(ticket.ticket_number)

    def test_registration_does_not_require_email_verification(self):
        with patch("app.api.create_email_verification") as send_verification:
            response = self.client.post("/api/v1/auth/register", json={
                "name": "New Customer",
                "email": "new.customer@example.com",
                "password": "Another-Valid-Password-123",
            })
        self.assertEqual(response.status_code, 201, response.get_json())
        self.assertNotIn("development_verification_url", response.get_json())
        self.assertTrue(User.query.filter_by(email="new.customer@example.com").one().email_verified_at)
        send_verification.assert_not_called()
        logged_in = self.client.post("/api/v1/auth/login", json={
            "email": "new.customer@example.com",
            "password": "Another-Valid-Password-123",
        })
        self.assertEqual(logged_in.status_code, 200)

    def test_unverified_customer_can_still_log_in(self):
        user = self.create_user("Unverified Customer", "unverified@example.com", "CUSTOMER", None)
        user.email_verified_at = None
        db.session.commit()
        response = self.client.post("/api/v1/auth/login", json={
            "email": "unverified@example.com",
            "password": "Valid-Crm-Password-123",
        })
        self.assertEqual(response.status_code, 200, response.get_json())

    def test_ticket_routes_by_category(self):
        headers = self.auth("customer@example.com")
        expected = {
            "PRODUCT_ENQUIRY": ("sales", self.sales.id),
            "PRODUCT_DEFECT": ("product-maintenance", self.maintenance.id),
            "TECHNICAL_SUPPORT": ("support", self.support.id),
        }
        for category, (department_slug, user_id) in expected.items():
            response = self.create_ticket(headers, category)
            self.assertEqual(response.status_code, 201, response.get_json())
            result = response.get_json()["ticket"]
            self.assertEqual(result["department"], Department.query.filter_by(slug=department_slug).one().name)
            self.assertEqual(result["assignee"]["id"], user_id)

    def test_product_defect_ticket_emails_active_product_maintenance_team(self):
        teammate = self.create_user(
            "Maintenance Teammate",
            "maintenance-teammate@example.com",
            "PRODUCT_MAINTENANCE",
            "product-maintenance",
        )
        inactive = self.create_user(
            "Inactive Maintenance",
            "inactive-maintenance@example.com",
            "PRODUCT_MAINTENANCE",
            "product-maintenance",
        )
        inactive.is_active = False
        db.session.commit()

        with patch("app.services.send_user_email", return_value=True) as send_email:
            response = self.create_ticket(
                self.auth("customer@example.com"),
                "PRODUCT_DEFECT",
            )

        self.assertEqual(response.status_code, 201, response.get_json())
        ticket = response.get_json()["ticket"]
        maintenance_emails = {
            call.args[0]: (call.args[1], call.args[2])
            for call in send_email.call_args_list
            if call.args[0] in {
                self.maintenance.email,
                teammate.email,
                inactive.email,
            }
        }
        self.assertEqual(set(maintenance_emails), {self.maintenance.email, teammate.email})
        for subject, body in maintenance_emails.values():
            self.assertEqual(subject, f"[{ticket['ticket_number']}] Product defect requires attention")
            self.assertIn("Product: CRM Suite", body)
            self.assertIn("Subject: A valid test subject", body)
            self.assertIn("Description: A detailed issue description.", body)

    def test_product_maintenance_can_resolve_defect_without_escalating(self):
        created = self.create_ticket(
            self.auth("customer@example.com"),
            "PRODUCT_DEFECT",
        )
        ticket = created.get_json()["ticket"]

        with patch("app.api.send_ticket_email", return_value=True), \
                patch("app.api.send_assignee_email", return_value=True):
            resolved = self.client.patch(
                f"/api/v1/tickets/{ticket['id']}",
                headers=self.auth("maintenance@example.com"),
                json={"status": "RESOLVED"},
            )

        self.assertEqual(resolved.status_code, 200, resolved.get_json())
        self.assertEqual(resolved.get_json()["status"], "RESOLVED")
        self.assertEqual(resolved.get_json()["department"], "Product Maintenance")

    def test_critical_priority_does_not_move_ticket_out_of_product_maintenance(self):
        created = self.create_ticket(
            self.auth("customer@example.com"),
            "PRODUCT_DEFECT",
        )
        ticket = created.get_json()["ticket"]

        updated = self.client.patch(
            f"/api/v1/tickets/{ticket['id']}",
            headers=self.auth("maintenance@example.com"),
            json={"priority": "CRITICAL"},
        )

        self.assertEqual(updated.status_code, 200, updated.get_json())
        self.assertEqual(updated.get_json()["priority"], "CRITICAL")
        self.assertEqual(updated.get_json()["department"], "Product Maintenance")

    def test_main_admin_can_view_ticket_details_read_only(self):
        created = self.create_ticket(
            self.auth("customer@example.com"),
            "PRODUCT_DEFECT",
        )
        ticket_id = created.get_json()["ticket"]["id"]
        headers = self.auth("admin@example.com")

        details = self.client.get(f"/api/v1/tickets/{ticket_id}", headers=headers)
        page = self.client.get("/api/v1/tickets", headers=headers)
        update = self.client.patch(
            f"/api/v1/tickets/{ticket_id}",
            headers=headers,
            json={"status": "RESOLVED"},
        )
        conversation = self.client.post(
            f"/api/v1/tickets/{ticket_id}/comments",
            headers=headers,
            json={"body": "This must remain restricted."},
        )
        attachment = self.client.post(
            f"/api/v1/tickets/{ticket_id}/documents",
            headers=headers,
        )

        self.assertEqual(details.status_code, 200)
        self.assertEqual(details.get_json()["id"], ticket_id)
        self.assertEqual(details.get_json()["subject"], "A valid test subject")
        self.assertIn("description", details.get_json())
        self.assertIn("customer", details.get_json())
        self.assertIn("priority", details.get_json())
        self.assertIn("department", details.get_json())
        self.assertNotIn("comments", details.get_json())
        self.assertEqual(page.status_code, 200)
        self.assertEqual(page.get_json()["results"][0]["id"], ticket_id)
        self.assertEqual(page.get_json()["results"][0]["subject"], "A valid test subject")
        self.assertIn("customer", page.get_json()["results"][0])
        self.assertEqual(conversation.status_code, 403)
        self.assertEqual(attachment.status_code, 403)
        audit = self.client.get("/api/v1/admin/audit-logs", headers=headers)
        ticket_audit = [
            item for item in audit.get_json()
            if item["object_type"] == "Ticket" and item["object_id"] == str(ticket_id)
        ]
        self.assertTrue(ticket_audit)
        self.assertTrue(all(set(item["details"]) == {"status"} for item in ticket_audit))
        self.assertEqual(update.status_code, 403)
        private_filter = self.client.get(
            "/api/v1/tickets?priority=CRITICAL",
            headers=headers,
        )
        self.assertEqual(private_filter.status_code, 403)
        created_by_admin = self.client.post(
            "/api/v1/tickets",
            headers=headers,
            json={
                "issue_category": "PRODUCT_DEFECT",
                "subject": "Admin created ticket",
                "description": "Should not be permitted.",
            },
        )
        self.assertEqual(created_by_admin.status_code, 403)

    def test_main_admin_ticket_notifications_only_include_status(self):
        created = self.create_ticket(
            self.auth("customer@example.com"),
            "PRODUCT_DEFECT",
        )
        ticket = db.session.get(Ticket, created.get_json()["ticket"]["id"])
        notification = Notification(
            recipient_id=self.admin.id,
            ticket_id=ticket.id,
            kind="CRITICAL_TICKET",
            title="Critical ticket requires immediate attention",
            body=f"{ticket.ticket_number}: {ticket.subject}",
            link=f"/tickets?ticket={ticket.id}",
        )
        db.session.add(notification)
        db.session.commit()

        response = self.client.get(
            "/api/v1/notifications",
            headers=self.auth("admin@example.com"),
        )

        self.assertEqual(response.status_code, 200)
        notice = next(item for item in response.get_json() if item["ticket_id"] == ticket.id)
        self.assertEqual(notice["title"], "Ticket status update")
        self.assertIn(ticket.status.title(), notice["body"])
        self.assertNotIn(ticket.subject, notice["body"])
        self.assertEqual(notice["link"], "")

    def test_main_admin_ticket_csv_report_contains_status_only(self):
        created = self.create_ticket(
            self.auth("customer@example.com"),
            "PRODUCT_DEFECT",
        )
        ticket = created.get_json()["ticket"]

        response = self.client.get(
            "/api/v1/admin/reports/tickets.csv",
            headers=self.auth("admin@example.com"),
        )

        report = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        self.assertIn("Ticket,Status", report)
        self.assertIn(f"{ticket['ticket_number']},ASSIGNED", report)
        self.assertNotIn("A valid test subject", report)

    def test_approval_and_escalation_endpoints_are_removed(self):
        created = self.create_ticket(
            self.auth("customer@example.com"),
            "PRODUCT_DEFECT",
        )
        ticket_id = created.get_json()["ticket"]["id"]
        headers = self.auth("admin@example.com")

        approval = self.client.post(
            f"/api/v1/tickets/{ticket_id}/approve-maintenance",
            headers=headers,
        )
        escalation = self.client.post(
            f"/api/v1/tickets/{ticket_id}/escalate",
            headers=self.auth("maintenance@example.com"),
        )

        self.assertEqual(approval.status_code, 404)
        self.assertEqual(escalation.status_code, 404)

    def test_ticket_list_includes_role_scoped_status_counts(self):
        tickets_by_category = {
            "PRODUCT_ENQUIRY": "NEW",
            "PRODUCT_DEFECT": "CLOSED",
            "TECHNICAL_SUPPORT": "IN_PROGRESS",
        }
        for category, status in tickets_by_category.items():
            response = self.create_ticket(self.auth("customer@example.com"), category)
            self.assertEqual(response.status_code, 201, response.get_json())
            ticket = db.session.get(Ticket, response.get_json()["ticket"]["id"])
            ticket.status = status
        db.session.commit()

        sales_response = self.client.get("/api/v1/tickets?status=NEW", headers=self.auth("sales@example.com"))
        support_response = self.client.get("/api/v1/tickets", headers=self.auth("support@example.com"))
        customer_response = self.client.get("/api/v1/tickets?per_page=1", headers=self.auth("customer@example.com"))

        expected_statuses = {
            "NEW": 0,
            "ASSIGNED": 0,
            "IN_PROGRESS": 0,
            "MEETING_SCHEDULED": 0,
            "RESOLVED": 0,
            "CLOSED": 0,
        }
        self.assertEqual(sales_response.status_code, 200, sales_response.get_json())
        sales_counts = dict(expected_statuses, NEW=1)
        self.assertEqual(sales_response.get_json()["total"], 1)
        self.assertEqual(sales_response.get_json()["status_counts"], sales_counts)
        self.assertEqual(support_response.status_code, 200, support_response.get_json())
        support_counts = dict(expected_statuses, IN_PROGRESS=1)
        self.assertEqual(support_response.get_json()["status_counts"], support_counts)
        self.assertEqual(customer_response.status_code, 200, customer_response.get_json())
        self.assertEqual(customer_response.get_json()["total"], 3)
        self.assertEqual(len(customer_response.get_json()["results"]), 1)
        customer_counts = dict(expected_statuses, NEW=1, IN_PROGRESS=1, CLOSED=1)
        self.assertEqual(customer_response.get_json()["status_counts"], customer_counts)

    def test_customer_cannot_choose_ticket_priority(self):
        response = self.create_ticket(self.auth("customer@example.com"), "TECHNICAL_SUPPORT", "CRITICAL")
        self.assertEqual(response.status_code, 201, response.get_json())
        ticket = response.get_json()["ticket"]
        self.assertEqual(ticket["priority"], "MEDIUM")
        self.assertEqual(ticket["department"], "Support")

    def test_critical_ticket_email_is_structured_and_escaped(self):
        response = self.create_ticket(self.auth("customer@example.com"), "PRODUCT_ENQUIRY")
        ticket = db.session.get(Ticket, response.get_json()["ticket"]["id"])
        ticket.priority = "CRITICAL"
        ticket.subject = "Urgent <account> issue"
        db.session.commit()

        text_body, html_body = _ticket_email_content(
            ticket,
            "Ticket escalated",
            ticket.customer.name,
            "https://meet.jit.si/TKT123",
        )

        self.assertIn("CRITICAL PRIORITY", text_body)
        self.assertIn("- Ticket ID: ", text_body)
        self.assertIn("- Customer: Customer (customer@example.com)", text_body)
        self.assertIn("- Subject: Urgent <account> issue", text_body)
        self.assertIn("- Priority: Critical", text_body)
        self.assertIn("- Status: Assigned", text_body)
        self.assertIn("- Update: Ticket escalated", text_body)
        self.assertIn("CRITICAL PRIORITY", html_body)
        self.assertIn("Urgent &lt;account&gt; issue", html_body)
        self.assertNotIn("Urgent <account> issue", html_body)
        self.assertIn("https://meet.jit.si/TKT123", html_body)

    def test_sales_enquiry_email_is_professional_and_escapes_content(self):
        text_body, html_body = sales_enquiry_email_content(
            "<Sales Manager>",
            "New sales enquiry",
            "A customer is interested in the product.",
            [("Contact", "Jordan <script>alert(1)</script>")],
            "Please share pricing & availability.",
            "Review lead in NEXUS CRM",
            "https://crm.example.com/leads",
        )

        self.assertIn("NEXUS CRM", text_body)
        self.assertIn("Please share pricing & availability.", text_body)
        self.assertIn("Review lead in NEXUS CRM: https://crm.example.com/leads", text_body)
        self.assertIn("background:#172744", html_body)
        self.assertIn('href="https://crm.example.com/leads"', html_body)
        self.assertIn("&lt;Sales Manager&gt;", html_body)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", html_body)
        self.assertNotIn("<script>", html_body)
        self.assertIn("Please share pricing &amp; availability.", html_body)

    def test_sales_assignment_email_matches_branded_notification_template(self):
        text_body, html_body = sales_assignment_email_content(
            [
                ("Contact Name", "Jordan <script>"),
                ("Email Address", "jordan@example.com"),
                ("Company Name", "Not provided"),
                ("Phone Number", "Not provided"),
                ("Product", "Nexus CRM"),
            ],
            "Please share pricing & availability.",
            "https://crm.example.com/leads",
        )

        self.assertIn("Hello Sales Team,", text_body)
        self.assertIn("received and assigned", text_body)
        self.assertIn("View Lead Details: https://crm.example.com/leads", text_body)
        self.assertIn(
            "This is an automated notification from Nexus CRM. "
            "Please review and follow up with the customer promptly.",
            text_body,
        )
        self.assertIn("New Sales Enquiry – Nexus CRM", html_body)
        self.assertIn("Hello Sales Team,", html_body)
        for label in (
            "Contact Name",
            "Email Address",
            "Company Name",
            "Phone Number",
            "Product",
        ):
            self.assertIn(label, html_body)
        self.assertIn('href="https://crm.example.com/leads"', html_body)
        self.assertIn(">View Lead Details</a>", html_body)
        self.assertIn("#14243a", html_body)
        self.assertIn("#d5a34b", html_body)
        self.assertIn("&lt;script&gt;", html_body)
        self.assertNotIn("<script>", html_body)
        self.assertIn("Please share pricing &amp; availability.", html_body)

    def test_only_assigned_department_can_change_priority(self):
        created = self.create_ticket(self.auth("customer@example.com"), "PRODUCT_ENQUIRY")
        ticket_id = created.get_json()["ticket"]["id"]

        denied = self.client.patch(
            f"/api/v1/tickets/{ticket_id}",
            headers=self.auth("support@example.com"),
            json={"priority": "HIGH"},
        )
        self.assertEqual(denied.status_code, 403)

        changed_by_department = self.client.patch(
            f"/api/v1/tickets/{ticket_id}",
            headers=self.auth("sales@example.com"),
            json={"priority": "HIGH"},
        )
        self.assertEqual(changed_by_department.status_code, 200, changed_by_department.get_json())
        self.assertEqual(changed_by_department.get_json()["priority"], "HIGH")

        changed_by_admin = self.client.patch(
            f"/api/v1/tickets/{ticket_id}",
            headers=self.auth("admin@example.com"),
            json={"priority": "LOW"},
        )
        self.assertEqual(changed_by_admin.status_code, 403, changed_by_admin.get_json())

    def test_customer_cannot_read_another_customers_ticket(self):
        created = self.create_ticket(self.auth("customer@example.com"), "PRODUCT_ENQUIRY")
        ticket_id = created.get_json()["ticket"]["id"]
        other = self.create_user("Other Customer", "other@example.com", "CUSTOMER", None)
        db.session.commit()
        response = self.client.get(f"/api/v1/tickets/{ticket_id}", headers=self.auth(other.email))
        self.assertEqual(response.status_code, 403, response.get_json())

    def test_only_admin_can_create_products_and_view_dashboard(self):
        customer_headers = self.auth("customer@example.com")
        denied = self.client.post("/api/v1/products", headers=customer_headers, json={
            "name": "Forbidden", "category": "Software", "price": 2,
        })
        self.assertEqual(denied.status_code, 403)
        admin_headers = self.auth("admin@example.com")
        created = self.client.post("/api/v1/products", headers=admin_headers, json={
            "name": "Admin product", "category": "Software", "price": 2,
        })
        self.assertEqual(created.status_code, 201, created.get_json())
        dashboard = self.client.get("/api/v1/admin/dashboard", headers=admin_headers)
        self.assertEqual(dashboard.status_code, 200, dashboard.get_json())
        self.assertEqual(dashboard.get_json()["total_users"], 5)

    def test_staff_role_must_match_its_routing_department(self):
        response = self.client.post("/api/v1/admin/users", headers=self.auth("admin@example.com"), json={
            "name": "Misrouted Agent",
            "email": "misrouted@example.com",
            "password": "Valid-Crm-Password-123",
            "role": "SALES_MANAGER",
            "department_id": Department.query.filter_by(slug="support").one().id,
        })
        self.assertEqual(response.status_code, 400)

    def test_sales_lead_converts_to_a_customer_and_routed_ticket(self):
        headers = self.auth("sales@example.com")
        created = self.client.post("/api/v1/leads", headers=headers, json={
            "contact_name": "Prospective Customer",
            "email": "prospect@example.com",
            "company": "Example Industries",
            "phone": "+1 555 0100",
            "product_id": self.product.id,
            "notes": "Needs product information.",
        })
        self.assertEqual(created.status_code, 201, created.get_json())
        lead = created.get_json()
        self.assertEqual(lead["status"], "NEW")
        self.assertEqual(lead["assignee"]["id"], self.sales.id)
        enquiry = self.client.post("/api/v1/leads/enquiry", json={
            "contact_name": "Prospective Customer",
            "email": "prospect@example.com",
            "product_id": self.product.id,
            "message": "Please send pricing details.",
        })
        self.assertEqual(enquiry.status_code, 201, enquiry.get_json())
        self.assertFalse(enquiry.get_json()["lead_created"])
        self.assertEqual(Lead.query.count(), 1)
        self.assertEqual(Enquiry.query.count(), 1)

        denied = self.client.post(f"/api/v1/leads/{lead['id']}/convert", headers=headers)
        self.assertEqual(denied.status_code, 409)
        support_headers = self.auth("support@example.com")
        updated = self.client.patch(f"/api/v1/support/leads/{lead['id']}", headers=support_headers, json={
            "customer_requirements": "Needs product information.",
            "support_verification_notes": "Contact information checked with the customer.",
            "customer_interest_status": "INTERESTED",
            "purchase_intent": "YES",
        })
        self.assertEqual(updated.status_code, 200, updated.get_json())
        submitted = self.client.post(f"/api/v1/support/leads/{lead['id']}/submit", headers=support_headers)
        self.assertEqual(submitted.status_code, 200, submitted.get_json())
        self.assertEqual(submitted.get_json()["approval_status"], "PENDING_APPROVAL")
        self.assertEqual(submitted.get_json()["support_verified_by"]["id"], self.support.id)
        self.assertIsNotNone(submitted.get_json()["submitted_for_approval_at"])
        forbidden = self.client.post(f"/api/v1/admin/leads/{lead['id']}/review", headers=support_headers, json={
            "action": "APPROVE",
        })
        self.assertEqual(forbidden.status_code, 403)
        admin_headers = self.auth("admin@example.com")
        approved = self.client.post(f"/api/v1/admin/leads/{lead['id']}/review", headers=admin_headers, json={
            "action": "APPROVE",
        })
        self.assertEqual(approved.status_code, 200, approved.get_json())
        self.assertEqual(approved.get_json()["approval_status"], "APPROVED")
        approval_history = self.client.get(
            f"/api/v1/leads/{lead['id']}/history",
            headers=admin_headers,
        )
        self.assertIn("APPROVED", [item["action"] for item in approval_history.get_json()])
        enquiry_history = self.client.get(
            f"/api/v1/leads/{lead['id']}/enquiries",
            headers=headers,
        )
        self.assertEqual(enquiry_history.status_code, 200, enquiry_history.get_json())
        self.assertEqual(enquiry_history.get_json()[0]["message"], "Please send pricing details.")
        denied_enquiry_history = self.client.get(
            f"/api/v1/leads/{lead['id']}/enquiries",
            headers=self.auth("customer@example.com"),
        )
        self.assertEqual(denied_enquiry_history.status_code, 403)
        purchase_denied = self.client.post(f"/api/v1/leads/{lead['id']}/convert", headers=headers)
        self.assertEqual(purchase_denied.status_code, 409)
        verified = self.client.post(f"/api/v1/leads/{lead['id']}/verify-purchase", headers=headers, json={
            "purchase_verification_notes": "Purchase reference confirmed by the customer.",
        })
        self.assertEqual(verified.status_code, 200, verified.get_json())
        converted = self.client.post(f"/api/v1/leads/{lead['id']}/convert", headers=headers)
        self.assertEqual(converted.status_code, 201, converted.get_json())
        result = converted.get_json()
        self.assertEqual(result["lead"]["status"], "CONVERTED")
        self.assertEqual(result["ticket"]["issue_category"], "PRODUCT_ENQUIRY")
        self.assertEqual(result["ticket"]["department"], "Sales")
        self.assertEqual(result["ticket"]["customer"]["email"], "prospect@example.com")
        customer = User.query.filter_by(email="prospect@example.com").one()
        converted_lead = db.session.get(Lead, lead["id"])
        self.assertIsNone(converted_lead.dedupe_key)
        self.assertEqual(converted_lead.customer_id, customer.id)
        self.assertEqual(Enquiry.query.one().customer_id, customer.id)
        self.assertEqual(lead["id"], Enquiry.query.one().lead_id)
        self.assertIsNotNone(customer.email_verified_at)
        self.assertNotIn("development_verification_url", result)
        self.assertNotIn("verification_email_sent", result)
        duplicate = self.client.post(f"/api/v1/leads/{lead['id']}/convert", headers=headers)
        self.assertEqual(duplicate.status_code, 409)

    def test_sales_manager_can_record_purchase_intent_before_admin_approval(self):
        headers = self.auth("sales@example.com")
        lead = Lead(
            contact_name="Unapproved Purchase Intent Prospect",
            email="unapproved-purchase-intent@example.com",
            product=self.product,
            assigned_to=self.sales,
            status="UNDER_REVIEW",
        )
        db.session.add(lead)
        db.session.commit()

        response = self.client.patch(
            f"/api/v1/leads/{lead.id}",
            headers=headers,
            json={"purchase_intent": "YES"},
        )

        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(response.get_json()["purchase_intent"], "YES")
        self.assertEqual(response.get_json()["approval_status"], "NOT_SUBMITTED")
        self.assertEqual(response.get_json()["status"], "UNDER_REVIEW")

        status_update = self.client.patch(
            f"/api/v1/leads/{lead.id}",
            headers=headers,
            json={"status": "CONTACTED"},
        )
        self.assertEqual(status_update.status_code, 409)

    def test_sales_manager_can_record_customer_purchase_intent_before_verifying(self):
        headers = self.auth("sales@example.com")
        lead = Lead(
            contact_name="Purchase Intent Prospect",
            email="purchase-intent@example.com",
            product=self.product,
            assigned_to=self.sales,
            approval_status="APPROVED",
        )
        db.session.add(lead)
        db.session.commit()

        response = self.client.patch(
            f"/api/v1/leads/{lead.id}",
            headers=headers,
            json={"purchase_intent": "YES"},
        )

        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(response.get_json()["purchase_intent"], "YES")
        self.assertEqual(response.get_json()["status"], "NEW")
        verified = self.client.post(
            f"/api/v1/leads/{lead.id}/verify-purchase",
            headers=headers,
        )
        self.assertEqual(verified.status_code, 200, verified.get_json())
        self.assertEqual(
            verified.get_json()["purchase_verification_notes"],
            "Purchase confirmed by Sales during lead conversion.",
        )
        converted = self.client.post(
            f"/api/v1/leads/{lead.id}/convert",
            headers=headers,
        )
        self.assertEqual(converted.status_code, 201, converted.get_json())

    def test_purchase_verification_can_confirm_intent_and_evidence_together(self):
        headers = self.auth("sales@example.com")
        lead = Lead(
            contact_name="Combined Purchase Confirmation",
            email="combined-purchase@example.com",
            product=self.product,
            assigned_to=self.sales,
            approval_status="APPROVED",
        )
        db.session.add(lead)
        db.session.commit()

        missing_confirmation = self.client.post(
            f"/api/v1/leads/{lead.id}/verify-purchase",
            headers=headers,
            json={"purchase_verification_notes": "Receipt checked with the customer."},
        )
        self.assertEqual(missing_confirmation.status_code, 409)
        self.assertEqual(Lead.query.get(lead.id).purchase_intent, "UNKNOWN")

        verified = self.client.post(
            f"/api/v1/leads/{lead.id}/verify-purchase",
            headers=headers,
            json={"purchase_intent": "YES"},
        )
        self.assertEqual(verified.status_code, 200, verified.get_json())
        self.assertEqual(verified.get_json()["purchase_intent"], "YES")
        self.assertIsNotNone(verified.get_json()["purchase_verified_at"])
        self.assertEqual(
            Lead.query.get(lead.id).purchase_intent,
            "YES",
        )
        converted = self.client.post(
            f"/api/v1/leads/{lead.id}/convert",
            headers=headers,
        )
        self.assertEqual(converted.status_code, 201, converted.get_json())

    def test_main_admin_can_verify_and_convert_lead_assigned_to_another_manager(self):
        lead = Lead(
            contact_name="Admin Conversion Prospect",
            email="admin-conversion@example.com",
            product=self.product,
            assigned_to=self.sales,
            approval_status="APPROVED",
            purchase_intent="YES",
            status="QUALIFIED",
        )
        db.session.add(lead)
        db.session.commit()
        admin_headers = self.auth("admin@example.com")

        verified = self.client.post(
            f"/api/v1/leads/{lead.id}/verify-purchase",
            headers=admin_headers,
            json={"purchase_verification_notes": "Purchase confirmed with the customer."},
        )
        self.assertEqual(verified.status_code, 200, verified.get_json())
        self.assertEqual(verified.get_json()["purchase_verified_by"]["id"], self.admin.id)

        converted = self.client.post(f"/api/v1/leads/{lead.id}/convert", headers=admin_headers)

        self.assertEqual(converted.status_code, 201, converted.get_json())
        result = converted.get_json()
        self.assertEqual(result["lead"]["status"], "CONVERTED")
        self.assertEqual(result["ticket"]["customer"]["email"], "admin-conversion@example.com")
        self.assertEqual(db.session.get(Lead, lead.id).assigned_to_id, self.sales.id)

    def test_lead_list_includes_visible_status_counts(self):
        for index, status in enumerate(("NEW", "QUALIFIED", "CONVERTED", "LOST", "UNDER_REVIEW")):
            db.session.add(Lead(
                contact_name=f"Lead {index}",
                email=f"lead{index}@example.com",
                product=self.product,
                assigned_to=self.sales,
                approval_status="APPROVED",
                status=status,
            ))
        db.session.commit()

        response = self.client.get("/api/v1/leads?status=NEW", headers=self.auth("sales@example.com"))

        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(response.get_json()["total"], 1)
        self.assertEqual(response.get_json()["status_counts"], {
            "NEW": 1,
            "UNDER_REVIEW": 1,
            "CONTACTED": 0,
            "INTERESTED": 0,
            "QUALIFIED": 1,
            "PURCHASE_PENDING": 0,
            "CONVERTED": 1,
            "LOST": 1,
            "DISQUALIFIED": 0,
        })

    def test_product_interest_is_idempotent_and_creates_no_unauthenticated_lead(self):
        session_ref = "6d10ceea-2c88-4811-943a-895421d12345"
        payload = {"product_id": self.product.id, "session_ref": session_ref}
        first = self.client.post("/api/v1/product-interests", json=payload)
        repeated = self.client.post("/api/v1/product-interests", json=payload)
        self.assertEqual(first.status_code, 201, first.get_json())
        self.assertEqual(repeated.status_code, 200, repeated.get_json())
        self.assertEqual(ProductInterestEvent.query.count(), 1)
        event = ProductInterestEvent.query.one()
        self.assertEqual(event.visit_count, 2)
        self.assertNotIn(session_ref, event.session_hash)
        self.assertEqual(Lead.query.count(), 0)

    def test_customer_product_interest_deduplicates_lead_and_notifies_support(self):
        headers = self.auth("customer@example.com")
        payload = {
            "product_id": self.product.id,
            "session_ref": "6d10ceea-2c88-4811-943a-895421d12345",
        }
        first = self.client.post("/api/v1/product-interests", headers=headers, json=payload)
        repeated = self.client.post("/api/v1/product-interests", headers=headers, json=payload)
        self.assertEqual(first.status_code, 201, first.get_json())
        self.assertEqual(repeated.status_code, 200, repeated.get_json())
        self.assertTrue(first.get_json()["lead_created"])
        self.assertEqual(Lead.query.count(), 1)
        lead = Lead.query.one()
        self.assertEqual(lead.source, "Product Interest")
        self.assertEqual(lead.approval_status, "NOT_SUBMITTED")
        self.assertEqual(lead.support_assigned_to_id, self.support.id)
        self.assertEqual(Notification.query.filter_by(recipient_id=self.support.id, kind="LEAD_REVIEW").count(), 1)

    def test_customer_product_interest_lead_appears_in_every_sales_manager_new_filter(self):
        second_sales = self.create_user(
            "Second Sales Manager",
            "sales2@example.com",
            "SALES_MANAGER",
            "sales",
        )
        response = self.client.post(
            "/api/v1/product-interests",
            headers=self.auth("customer@example.com"),
            json={
                "product_id": self.product.id,
                "session_ref": "customer-interest-session-12345",
            },
        )
        self.assertEqual(response.status_code, 201, response.get_json())
        lead_id = response.get_json()["lead"]["id"]
        second_sales_headers = self.auth(second_sales.email)

        pipeline = self.client.get(
            "/api/v1/leads?status=NEW",
            headers=second_sales_headers,
        )
        self.assertEqual(pipeline.status_code, 200, pipeline.get_json())
        self.assertEqual(pipeline.get_json()["total"], 1)
        self.assertEqual(pipeline.get_json()["results"][0]["id"], lead_id)
        self.assertEqual(
            self.client.get(
                f"/api/v1/leads/{lead_id}",
                headers=second_sales_headers,
            ).status_code,
            200,
        )
        notice = Notification.query.filter_by(
            recipient_id=second_sales.id,
            kind="LEAD_ASSIGNED",
        ).one()
        self.assertEqual(notice.link, f"/leads?origin=customer&lead={lead_id}")

        submitted = self.client.post(
            f"/api/v1/leads/{lead_id}/verify",
            headers=second_sales_headers,
            json={
                "verification_notes": "Confirmed customer identity and product interest.",
                "product_id": self.product.id,
            },
        )
        self.assertEqual(submitted.status_code, 200, submitted.get_json())
        self.assertEqual(submitted.get_json()["approval_status"], "PENDING_APPROVAL")

    def test_customer_sales_enquiry_routes_existing_product_interest_lead_to_sales(self):
        headers = self.auth("customer@example.com")
        self.client.post("/api/v1/product-interests", headers=headers, json={
            "product_id": self.product.id,
            "session_ref": "6d10ceea-2c88-4811-943a-895421d12345",
        })
        lead = Lead.query.one()
        self.assertEqual(lead.approval_status, "NOT_SUBMITTED")

        response = self.client.post("/api/v1/leads/enquiry", headers=headers, json={
            "type": "sales_enquiry",
            "product_id": self.product.id,
            "message": "Please contact me about pricing.",
        })

        self.assertEqual(response.status_code, 201, response.get_json())
        self.assertFalse(response.get_json()["lead_created"])
        self.assertEqual(lead.approval_status, "NOT_SUBMITTED")
        sales_leads = self.client.get("/api/v1/leads", headers=self.auth("sales@example.com"))
        self.assertEqual(sales_leads.status_code, 200, sales_leads.get_json())
        self.assertEqual(sales_leads.get_json()["total"], 1)

    def test_sales_manager_verification_notifies_main_admin_for_approval(self):
        with patch("app.api.queue_crm_email", return_value=True) as queue_email:
            response = self.client.post("/api/v1/leads/enquiry", headers=self.auth("customer@example.com"), json={
                "type": "sales_enquiry",
                "product_id": self.product.id,
                "message": "Please contact me about pricing.",
            })
        lead_id = response.get_json()["id"]
        sales_headers = self.auth("sales@example.com")

        visible = self.client.get(f"/api/v1/leads/{lead_id}", headers=sales_headers)
        self.assertEqual(visible.status_code, 200, visible.get_json())
        self.assertEqual(visible.get_json()["approval_status"], "NOT_SUBMITTED")
        self.assertEqual(
            self.client.patch(f"/api/v1/leads/{lead_id}", headers=sales_headers, json={"status": "QUALIFIED"}).status_code,
            409,
        )

        with patch("app.api.queue_crm_email", return_value=True) as queue_email:
            verified = self.client.post(
                f"/api/v1/leads/{lead_id}/verify",
                headers=sales_headers,
                json={"verification_notes": "Confirmed the customer's email and product interest."},
            )

        self.assertEqual(verified.status_code, 200, verified.get_json())
        result = verified.get_json()
        self.assertEqual(result["approval_status"], "PENDING_APPROVAL")
        self.assertEqual(result["support_verified_by"]["id"], self.sales.id)
        self.assertEqual(Lead.query.get(lead_id).status, "NEW")
        self.assertEqual(
            Notification.query.filter_by(
                recipient_id=self.admin.id,
                kind="LEAD_APPROVAL",
            ).count(),
            1,
        )
        self.assertEqual(
            [call.args[1] for call in queue_email.call_args_list],
            [self.admin.email],
        )
        admin_queue = self.client.get(
            "/api/v1/admin/lead-approvals",
            headers=self.auth("admin@example.com"),
        )
        self.assertEqual(admin_queue.status_code, 200, admin_queue.get_json())
        self.assertEqual([item["id"] for item in admin_queue.get_json()["results"]], [lead_id])
        approved = self.client.post(
            f"/api/v1/admin/leads/{lead_id}/review",
            headers=self.auth("admin@example.com"),
            json={"action": "APPROVE"},
        )
        self.assertEqual(approved.status_code, 200, approved.get_json())
        self.assertEqual(approved.get_json()["approval_status"], "APPROVED")
        self.assertEqual(
            Notification.query.filter_by(
                recipient_id=self.sales.id,
                kind="LEAD_APPROVAL_RESULT",
            ).count(),
            1,
        )

    def test_support_can_review_anonymous_product_interest_without_session_data(self):
        payload = {
            "product_id": self.product.id,
            "session_ref": "6d10ceea-2c88-4811-943a-895421d12345",
        }
        event_response = self.client.post("/api/v1/product-interests", json=payload)
        self.assertEqual(event_response.status_code, 201)
        response = self.client.get(
            "/api/v1/support/product-interests",
            headers=self.auth("support@example.com"),
        )
        self.assertEqual(response.status_code, 200, response.get_json())
        result = response.get_json()["results"][0]
        self.assertEqual(result["product_name"], self.product.name)
        self.assertNotIn("session_hash", result)
        self.assertNotIn("customer_id", result)
        denied = self.client.get(
            "/api/v1/support/product-interests",
            headers=self.auth("sales@example.com"),
        )
        self.assertEqual(denied.status_code, 403)

    def test_website_enquiry_links_anonymous_product_interest(self):
        session_ref = "6d10ceea-2c88-4811-943a-895421d12345"
        self.client.post("/api/v1/product-interests", json={
            "product_id": self.product.id,
            "session_ref": session_ref,
        })
        response = self.client.post("/api/v1/leads/enquiry", json={
            "contact_name": "Website Visitor",
            "email": "visitor@example.com",
            "phone": "+1 555 0199",
            "product_id": self.product.id,
            "customer_requirements": "Interested in the CRM suite.",
            "session_ref": session_ref,
        })
        self.assertEqual(response.status_code, 201, response.get_json())
        event = ProductInterestEvent.query.one()
        self.assertEqual(event.lead_id, response.get_json()["id"])

    def test_customer_can_create_sales_lead_from_customer_enquiry(self):
        with patch("app.api.queue_crm_email", return_value=True) as queue_email:
            response = self.client.post(
                "/api/v1/leads/enquiry",
                headers=self.auth("customer@example.com"),
                json={
                    "type": "sales_enquiry",
                    "product_id": self.product.id,
                    "company": "Customer Company",
                    "phone": "+1 555 0199",
                    "message": "Please send me pricing details.",
                },
            )

        self.assertEqual(response.status_code, 201, response.get_json())
        result = response.get_json()
        self.assertTrue(result["lead_created"])
        self.assertTrue(result["confirmation_email_queued"])
        self.assertEqual(result["contact_name"], "Customer")
        self.assertEqual(result["email"], "customer@example.com")
        self.assertEqual(result["company"], "Customer Company")
        self.assertEqual(result["phone"], "+1 555 0199")
        lead = Lead.query.one()
        self.assertEqual(lead.customer_id, self.customer.id)
        self.assertEqual(lead.source, "Customer Enquiry")
        self.assertEqual(lead.approval_status, "NOT_SUBMITTED")
        self.assertEqual(lead.assigned_to_id, self.sales.id)
        self.assertEqual(lead.customer_requirements, "Please send me pricing details.")
        self.assertEqual(Enquiry.query.one().type, "SALES_ENQUIRY")
        self.assertEqual(
            [entry.action for entry in lead.approval_history],
            ["ENQUIRY_CREATED"],
        )
        self.assertEqual(
            {call.args[1] for call in queue_email.call_args_list},
            {"customer@example.com", "sales@example.com"},
        )
        sales_leads = self.client.get(
            "/api/v1/leads", headers=self.auth("sales@example.com")
        )
        self.assertEqual(sales_leads.status_code, 200, sales_leads.get_json())
        self.assertEqual(sales_leads.get_json()["total"], 1)
        self.assertEqual(sales_leads.get_json()["results"][0]["id"], lead.id)
        self.assertEqual(
            Notification.query.filter_by(
                recipient_id=self.sales.id,
                kind="LEAD_ASSIGNED",
            ).count(),
            1,
        )
        queued_recipients = {
            call.args[1] for call in queue_email.call_args_list
        }
        self.assertEqual(
            queued_recipients,
            {"customer@example.com", "sales@example.com"},
        )
        lead_email_calls = queue_email.call_args_list
        self.assertEqual(len(lead_email_calls), 2)
        customer_email = next(
            call for call in lead_email_calls
            if call.args[1] == "customer@example.com"
        )
        sales_email = next(
            call for call in lead_email_calls
            if call.args[1] == "sales@example.com"
        )
        self.assertIn("Thank you for your enquiry", customer_email.args[2])
        self.assertIn("NEXUS CRM", customer_email.args[3])
        self.assertIn("background:#172744", customer_email.kwargs["html"])
        self.assertIn("Please send me pricing details.", customer_email.kwargs["html"])
        self.assertEqual(sales_email.args[2], "New Sales Enquiry – Nexus CRM")
        self.assertIn("Hello Sales Team,", sales_email.args[3])
        self.assertIn("Contact Name", sales_email.kwargs["html"])
        self.assertIn("Email Address", sales_email.kwargs["html"])
        self.assertIn("Company Name", sales_email.kwargs["html"])
        self.assertIn("Phone Number", sales_email.kwargs["html"])
        self.assertIn("View Lead Details", sales_email.kwargs["html"])
        self.assertIn("CRM Suite", sales_email.kwargs["html"])
        self.assertIn(
            f'{self.app.config["FRONTEND_URL"]}/leads',
            sales_email.kwargs["html"],
        )

    def test_customer_sales_enquiries_are_shared_with_all_sales_managers(self):
        second_sales = self.create_user(
            "Second Sales Manager",
            "sales2@example.com",
            "SALES_MANAGER",
            "sales",
        )
        response = self.client.post("/api/v1/leads/enquiry", json={
            "name": "Website Prospect",
            "email": "website.prospect@example.com",
            "product_id": self.product.id,
            "message": "Please contact me about a CRM subscription.",
            "source": "website",
        })
        self.assertEqual(response.status_code, 201, response.get_json())
        lead_id = response.get_json()["id"]
        lead = db.session.get(Lead, lead_id)
        self.assertEqual(lead.assigned_to_id, self.sales.id)

        headers = self.auth(second_sales.email)
        listed = self.client.get("/api/v1/leads", headers=headers)
        self.assertEqual(listed.status_code, 200, listed.get_json())
        self.assertEqual(listed.get_json()["total"], 1)
        self.assertEqual(listed.get_json()["results"][0]["id"], lead_id)
        lead.status = "QUALIFIED"
        db.session.commit()
        customer_enquiries = self.client.get(
            "/api/v1/leads?origin=customer",
            headers=headers,
        )
        self.assertEqual(customer_enquiries.status_code, 200, customer_enquiries.get_json())
        self.assertEqual(customer_enquiries.get_json()["total"], 1)
        self.assertEqual(customer_enquiries.get_json()["results"][0]["id"], lead_id)
        self.assertEqual(
            self.client.get(f"/api/v1/leads/{lead_id}", headers=headers).status_code,
            200,
        )
        self.assertEqual(
            self.client.get(
                f"/api/v1/leads/{lead_id}/enquiries",
                headers=headers,
            ).status_code,
            200,
        )
        self.assertEqual(
            Notification.query.filter_by(
                recipient_id=second_sales.id,
                kind="LEAD_ASSIGNED",
            ).count(),
            1,
        )
        assignment_notice = Notification.query.filter_by(
            recipient_id=second_sales.id,
            kind="LEAD_ASSIGNED",
        ).one()
        first_enquiry = Enquiry.query.filter_by(
            lead_id=lead_id,
            type="SALES_ENQUIRY",
        ).one()
        self.assertEqual(
            assignment_notice.link,
            f"/leads?origin=customer&enquiry={first_enquiry.id}",
        )

        follow_up = self.client.post("/api/v1/leads/enquiry", json={
            "name": "Website Prospect",
            "email": "website.prospect@example.com",
            "product_id": self.product.id,
            "message": "Please send the enterprise pricing guide.",
            "source": "website",
        })
        self.assertEqual(follow_up.status_code, 201, follow_up.get_json())
        self.assertEqual(follow_up.get_json()["id"], lead_id)
        enquiry_rows = self.client.get(
            "/api/v1/leads/enquiries",
            headers=headers,
        )
        self.assertEqual(enquiry_rows.status_code, 200, enquiry_rows.get_json())
        self.assertEqual(enquiry_rows.get_json()["total"], 2)
        self.assertEqual(
            {item["message"] for item in enquiry_rows.get_json()["results"]},
            {
                "Please contact me about a CRM subscription.",
                "Please send the enterprise pricing guide.",
            },
        )
        self.assertTrue(all(item["lead"]["id"] == lead_id for item in enquiry_rows.get_json()["results"]))

        internal_lead = Lead(
            contact_name="Assigned only",
            email="assigned.only@example.com",
            assigned_to=self.sales,
            created_by=self.sales,
        )
        db.session.add(internal_lead)
        db.session.commit()
        second_manager_leads = self.client.get("/api/v1/leads", headers=headers)
        self.assertEqual(second_manager_leads.get_json()["total"], 1)
        customer_enquiries = self.client.get(
            "/api/v1/leads?origin=customer",
            headers=headers,
        )
        self.assertEqual(customer_enquiries.get_json()["total"], 1)
        self.assertEqual(customer_enquiries.get_json()["results"][0]["id"], lead_id)
        enquiry_rows = self.client.get(
            "/api/v1/leads/enquiries",
            headers=headers,
        )
        self.assertEqual(enquiry_rows.get_json()["total"], 2)
        denied = self.client.get(
            f"/api/v1/leads/{internal_lead.id}",
            headers=headers,
        )
        self.assertEqual(denied.status_code, 403)

    def test_shared_sales_manager_can_submit_and_follow_up_after_admin_approval(self):
        second_sales = self.create_user(
            "Second Sales Manager",
            "sales2@example.com",
            "SALES_MANAGER",
            "sales",
        )
        created = self.client.post("/api/v1/leads/enquiry", json={
            "name": "Approval Prospect",
            "email": "approval.prospect@example.com",
            "product_id": self.product.id,
            "message": "Please contact me about subscription pricing.",
        })
        self.assertEqual(created.status_code, 201, created.get_json())
        lead_id = created.get_json()["id"]
        second_sales_headers = self.auth(second_sales.email)

        submitted = self.client.post(
            f"/api/v1/leads/{lead_id}/verify",
            headers=second_sales_headers,
            json={
                "verification_notes": "Confirmed contact information and product interest.",
                "product_id": self.product.id,
            },
        )
        self.assertEqual(submitted.status_code, 200, submitted.get_json())
        self.assertEqual(submitted.get_json()["approval_status"], "PENDING_APPROVAL")

        admin_queue = self.client.get(
            "/api/v1/leads/approvals",
            headers=self.auth("admin@example.com"),
        )
        self.assertEqual(admin_queue.status_code, 200, admin_queue.get_json())
        self.assertIn(lead_id, [item["id"] for item in admin_queue.get_json()["results"]])
        approved = self.client.post(
            f"/api/v1/leads/{lead_id}/review",
            headers=self.auth("admin@example.com"),
            json={"action": "APPROVE"},
        )
        self.assertEqual(approved.status_code, 200, approved.get_json())
        self.assertEqual(approved.get_json()["approval_status"], "APPROVED")

        approval_notice = Notification.query.filter_by(
            recipient_id=second_sales.id,
            kind="LEAD_APPROVAL_RESULT",
        ).one()
        self.assertEqual(approval_notice.link, f"/leads?lead={lead_id}")
        reopened = self.client.get(
            f"/api/v1/leads/{lead_id}",
            headers=second_sales_headers,
        )
        self.assertEqual(reopened.status_code, 200, reopened.get_json())
        self.assertEqual(reopened.get_json()["approval_status"], "APPROVED")

        intent = self.client.patch(
            f"/api/v1/leads/{lead_id}",
            headers=second_sales_headers,
            json={"purchase_intent": "YES"},
        )
        self.assertEqual(intent.status_code, 200, intent.get_json())
        verified = self.client.post(
            f"/api/v1/leads/{lead_id}/verify-purchase",
            headers=second_sales_headers,
            json={"purchase_intent": "YES"},
        )
        self.assertEqual(verified.status_code, 200, verified.get_json())
        self.assertEqual(verified.get_json()["purchase_intent"], "YES")
        self.assertIsNotNone(verified.get_json()["purchase_verified_at"])

    def test_email_is_not_reported_as_queued_without_smtp_credentials(self):
        with patch("app.services._lead_email_executor.submit") as submit:
            queued = queue_crm_email(
                self.app,
                "sales@example.com",
                "New sales enquiry",
                "A new lead was assigned.",
            )

        self.assertFalse(queued)
        submit.assert_not_called()

    def test_guest_sales_enquiries_deduplicate_by_email_and_keep_history(self):
        another_product = Product(
            name="Analytics Add-on",
            category="Software",
            description="Reporting tools",
            price=5,
            status="ACTIVE",
        )
        db.session.add(another_product)
        db.session.commit()
        first = self.client.post("/api/v1/enquire", json={
            "name": "Guest Prospect",
            "email": "same@example.com",
            "product_id": self.product.id,
            "message": "I need a CRM for my team.",
            "source": "website",
        })
        repeated = self.client.post("/api/v1/enquire", json={
            "name": "Guest Prospect",
            "email": "SAME@example.com",
            "product_id": another_product.id,
            "message": "Also interested in analytics.",
        })
        self.assertEqual(first.status_code, 201, first.get_json())
        self.assertEqual(repeated.status_code, 201, repeated.get_json())
        self.assertTrue(first.get_json()["lead_created"])
        self.assertFalse(repeated.get_json()["lead_created"])
        self.assertEqual(Lead.query.count(), 1)
        self.assertEqual(Enquiry.query.count(), 2)
        lead = Lead.query.one()
        self.assertEqual(lead.product_id, another_product.id)
        self.assertEqual(lead.status, "NEW")
        self.assertEqual(repeated.get_json()["enquiry"]["message"], "Also interested in analytics.")

    def test_signed_in_sales_and_support_enquiries_follow_separate_paths(self):
        headers = self.auth("customer@example.com")
        sales = self.client.post("/api/v1/enquire", headers=headers, json={
            "type": "sales_enquiry",
            "email": "different@example.com",
            "product_id": self.product.id,
            "message": "I would like to add another license.",
        })
        self.assertEqual(sales.status_code, 201, sales.get_json())
        self.assertEqual(Lead.query.one().customer_id, self.customer.id)
        self.assertEqual(Enquiry.query.one().customer_id, self.customer.id)
        support = self.client.post("/api/v1/enquire", headers=headers, json={
            "type": "support_request",
            "subject": "Cannot sign in",
            "message": "The sign-in form rejects my password.",
        })
        self.assertEqual(support.status_code, 201, support.get_json())
        self.assertEqual(support.get_json()["ticket"]["department"], "Support")
        self.assertEqual(Lead.query.count(), 1)
        self.assertEqual(Enquiry.query.count(), 1)
        guest_support = self.client.post("/api/v1/enquire", json={
            "type": "support_request",
            "message": "Please help.",
        })
        self.assertEqual(guest_support.status_code, 401)

    def test_overdue_support_follow_up_notification_is_idempotent(self):
        lead = Lead(
            contact_name="Prospective Customer",
            email="prospect@example.com",
            product=self.product,
            support_assigned_to=self.support,
            customer_requirements="Wants a product walkthrough.",
            follow_up_at=datetime.now(timezone.utc) - timedelta(minutes=1),
        )
        db.session.add(lead)
        db.session.commit()
        headers = self.auth("support@example.com")
        first = self.client.get("/api/v1/notifications", headers=headers)
        second = self.client.get("/api/v1/notifications", headers=headers)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        notices = Notification.query.filter_by(
            recipient_id=self.support.id,
            kind="LEAD_FOLLOW_UP_OVERDUE",
        ).all()
        self.assertEqual(len(notices), 1)

    def test_smtp_queue_failure_does_not_lose_a_new_lead(self):
        self.app.config.update(
            TESTING=False,
            MAIL_USERNAME="crm@example.com",
            MAIL_PASSWORD="test-password",
        )
        with patch("app.services._lead_email_executor.submit", side_effect=RuntimeError("queue unavailable")):
            response = self.client.post("/api/v1/leads/enquiry", json={
                "contact_name": "Queue Failure Visitor",
                "email": "queue.failure@example.com",
                "product_id": self.product.id,
                "customer_requirements": "Needs pricing details.",
            })
        self.assertEqual(response.status_code, 201, response.get_json())
        self.assertTrue(Lead.query.filter_by(email="queue.failure@example.com").one())

    def test_support_cannot_submit_lead_with_missing_verification_requirements(self):
        lead = Lead(
            contact_name="Prospective Customer",
            email="prospect@example.com",
            product=self.product,
            assigned_to=self.sales,
            support_assigned_to=self.support,
        )
        db.session.add(lead)
        db.session.commit()
        response = self.client.post(
            f"/api/v1/support/leads/{lead.id}/submit",
            headers=self.auth("support@example.com"),
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("missing_fields", response.get_json()["details"])

    def test_support_access_is_limited_to_assigned_leads(self):
        other_support = self.create_user(
            "Other Support",
            "other.support@example.com",
            "SUPPORT",
            "support",
        )
        db.session.commit()
        lead = Lead(
            contact_name="Assigned Customer",
            email="assigned@example.com",
            product=self.product,
            support_assigned_to=self.support,
        )
        db.session.add(lead)
        db.session.commit()
        headers = self.auth(other_support.email)
        detail = self.client.get(f"/api/v1/support/leads/{lead.id}", headers=headers)
        update = self.client.patch(
            f"/api/v1/support/leads/{lead.id}",
            headers=headers,
            json={"support_verification_notes": "Unauthorized change."},
        )
        self.assertEqual(detail.status_code, 403)
        self.assertEqual(update.status_code, 403)

    def test_product_maintenance_cannot_access_lead_verification(self):
        lead = Lead(
            contact_name="Product Maintenance Prospect",
            email="maintenance.prospect@example.com",
            product=self.product,
            support_assigned_to=self.support,
        )
        db.session.add(lead)
        db.session.commit()
        headers = self.auth("maintenance@example.com")

        queue = self.client.get("/api/v1/support/leads", headers=headers)
        detail = self.client.get(
            f"/api/v1/support/leads/{lead.id}",
            headers=headers,
        )
        update = self.client.patch(
            f"/api/v1/support/leads/{lead.id}",
            headers=headers,
            json={"support_verification_notes": "Not authorized."},
        )
        submit = self.client.post(
            f"/api/v1/support/leads/{lead.id}/submit",
            headers=headers,
        )
        history = self.client.get(
            f"/api/v1/leads/{lead.id}/history",
            headers=headers,
        )

        self.assertEqual(queue.status_code, 403)
        self.assertEqual(detail.status_code, 403)
        self.assertEqual(update.status_code, 403)
        self.assertEqual(submit.status_code, 403)
        self.assertEqual(history.status_code, 403)

    def test_admin_rejection_and_information_request_allow_corrected_resubmission(self):
        support_headers = self.auth("support@example.com")
        admin_headers = self.auth("admin@example.com")
        created = self.client.post("/api/v1/leads", headers=self.auth("sales@example.com"), json={
            "contact_name": "Correction Candidate",
            "email": "correction@example.com",
            "product_id": self.product.id,
        })
        self.assertEqual(created.status_code, 201, created.get_json())
        lead_id = created.get_json()["id"]
        verification = {
            "customer_requirements": "Needs the CRM suite.",
            "support_verification_notes": "Email and product interest checked.",
            "customer_interest_status": "AWAITING_RESPONSE",
        }
        self.client.patch(
            f"/api/v1/support/leads/{lead_id}",
            headers=support_headers,
            json=verification,
        )
        submitted = self.client.post(
            f"/api/v1/support/leads/{lead_id}/submit",
            headers=support_headers,
        )
        self.assertEqual(submitted.status_code, 200, submitted.get_json())
        missing_reason = self.client.post(
            f"/api/v1/admin/leads/{lead_id}/review",
            headers=admin_headers,
            json={"action": "REJECT"},
        )
        self.assertEqual(missing_reason.status_code, 400)
        rejected = self.client.post(
            f"/api/v1/admin/leads/{lead_id}/review",
            headers=admin_headers,
            json={"action": "REJECT", "comment": "Please confirm the requested plan."},
        )
        self.assertEqual(rejected.status_code, 200, rejected.get_json())
        self.assertEqual(rejected.get_json()["approval_status"], "REJECTED")
        self.assertEqual(rejected.get_json()["rejection_reason"], "Please confirm the requested plan.")

        self.client.patch(
            f"/api/v1/support/leads/{lead_id}",
            headers=support_headers,
            json={**verification, "customer_requirements": "Confirmed the CRM suite and requested plan."},
        )
        resubmitted = self.client.post(
            f"/api/v1/support/leads/{lead_id}/submit",
            headers=support_headers,
        )
        self.assertEqual(resubmitted.status_code, 200, resubmitted.get_json())
        self.assertEqual(resubmitted.get_json()["resubmission_count"], 1)
        needs_information = self.client.post(
            f"/api/v1/admin/leads/{lead_id}/review",
            headers=admin_headers,
            json={"action": "NEEDS_INFORMATION", "comment": "Please confirm the delivery timeframe."},
        )
        self.assertEqual(needs_information.status_code, 200, needs_information.get_json())
        self.assertEqual(needs_information.get_json()["approval_status"], "NEEDS_INFORMATION")
        history = self.client.get(
            f"/api/v1/leads/{lead_id}/history",
            headers=admin_headers,
        )
        self.assertEqual(
            [entry["action"] for entry in history.get_json()],
            ["CREATED", "SUPPORT_UPDATED", "SUBMITTED", "REJECTED", "SUPPORT_UPDATED", "RESUBMITTED", "NEEDS_INFORMATION"],
        )

    def test_customer_cannot_access_sales_leads(self):
        response = self.client.get("/api/v1/leads", headers=self.auth("customer@example.com"))
        self.assertEqual(response.status_code, 403, response.get_json())

    def test_login_endpoint_enforces_rate_limit(self):
        statuses = [
            self.client.post("/api/v1/auth/login", json={
                "email": "missing@example.com",
                "password": "invalid",
            }).status_code
            for _ in range(11)
        ]
        self.assertEqual(statuses[:10], [401] * 10)
        self.assertEqual(statuses[10], 429)

    def test_routing_departments_cannot_be_renamed_or_deleted(self):
        headers = self.auth("admin@example.com")
        sales = Department.query.filter_by(slug="sales").one()
        renamed = self.client.patch(f"/api/v1/admin/departments/{sales.id}", headers=headers, json={
            "slug": "sales-archive",
        })
        self.assertEqual(renamed.status_code, 409)
        deleted = self.client.delete(f"/api/v1/admin/departments/{sales.id}", headers=headers)
        self.assertEqual(deleted.status_code, 409)

    def test_meeting_uses_ticket_room_and_updates_ticket(self):
        created = self.create_ticket(self.auth("customer@example.com"), "PRODUCT_ENQUIRY")
        ticket = created.get_json()["ticket"]
        headers = self.auth("sales@example.com")
        start = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
        response = self.client.post("/api/v1/meetings", headers=headers, json={
            "ticket_id": ticket["id"],
            "starts_at": start,
            "duration_minutes": 45,
        })
        self.assertEqual(response.status_code, 201, response.get_json())
        self.assertEqual(response.get_json()["meeting"]["jitsi_url"], f"https://meet.jit.si/{ticket['ticket_number']}")
        self.assertTrue(response.get_json()["created"])
        self.assertEqual(db.session.get(Ticket, ticket["id"]).status, "MEETING_SCHEDULED")

    def test_approved_sales_lead_can_schedule_idempotent_meeting(self):
        created = self.client.post("/api/v1/leads/enquiry", json={
            "name": "Meeting Prospect",
            "email": "meeting.prospect@example.com",
            "product_id": self.product.id,
            "message": "I would like to discuss a subscription.",
            "source": "website",
        })
        self.assertEqual(created.status_code, 201, created.get_json())
        lead = db.session.get(Lead, created.get_json()["id"])
        lead.approval_status = "APPROVED"
        db.session.commit()

        payload = {
            "lead_id": lead.id,
            "starts_at": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
            "duration_minutes": 45,
        }
        headers = self.auth("sales@example.com")
        with patch("app.api.queue_crm_email", return_value=True) as send_email:
            first = self.client.post("/api/v1/meetings", headers=headers, json=payload)
            self.assertEqual(first.status_code, 201, first.get_json())
            second = self.client.post("/api/v1/meetings", headers=headers, json=payload)
            self.assertEqual(second.status_code, 200, second.get_json())

        meeting = first.get_json()["meeting"]
        self.assertTrue(first.get_json()["created"])
        self.assertFalse(second.get_json()["created"])
        self.assertEqual(meeting["lead_id"], lead.id)
        self.assertIsNone(meeting["ticket_id"])
        self.assertEqual(meeting["lead_contact_name"], "Meeting Prospect")
        self.assertTrue(meeting["jitsi_url"].startswith("https://meet.jit.si/NexusCRM-Lead-"))
        self.assertEqual(Meeting.query.filter_by(lead_id=lead.id).count(), 1)
        send_email.assert_called_once()

        listed = self.client.get(
            f"/api/v1/meetings?lead_id={lead.id}",
            headers=headers,
        )
        self.assertEqual(listed.status_code, 200, listed.get_json())
        self.assertEqual([item["id"] for item in listed.get_json()], [meeting["id"]])

    def test_upcoming_meetings_filter_only_returns_future_meetings(self):
        ticket_response = self.create_ticket(self.auth("customer@example.com"), "TECHNICAL_SUPPORT")
        ticket_id = ticket_response.get_json()["ticket"]["id"]
        now = datetime.now(timezone.utc)
        past = Meeting(
            ticket_id=ticket_id,
            starts_at=now - timedelta(days=1),
            duration_minutes=30,
            jitsi_url="https://meet.jit.si/past",
        )
        future = Meeting(
            ticket_id=ticket_id,
            starts_at=now + timedelta(days=1),
            duration_minutes=30,
            jitsi_url="https://meet.jit.si/future",
        )
        db.session.add_all([past, future])
        db.session.commit()
        headers = self.auth("customer@example.com")

        all_meetings = self.client.get("/api/v1/meetings", headers=headers)
        upcoming_meetings = self.client.get("/api/v1/meetings?upcoming=true", headers=headers)

        self.assertEqual(all_meetings.status_code, 200, all_meetings.get_json())
        self.assertEqual(upcoming_meetings.status_code, 200, upcoming_meetings.get_json())
        self.assertEqual(len(all_meetings.get_json()), 2)
        self.assertEqual([meeting["id"] for meeting in upcoming_meetings.get_json()], [future.id])

    def test_lead_meeting_requires_approval_and_sales_access(self):
        created = self.client.post("/api/v1/leads/enquiry", json={
            "name": "Pending Prospect",
            "email": "pending.prospect@example.com",
            "product_id": self.product.id,
            "message": "Please arrange a product call.",
            "source": "website",
        })
        self.assertEqual(created.status_code, 201, created.get_json())
        lead_id = created.get_json()["id"]
        payload = {
            "lead_id": lead_id,
            "starts_at": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
        }
        sales_headers = self.auth("sales@example.com")
        pending = self.client.post("/api/v1/meetings", headers=sales_headers, json=payload)
        self.assertEqual(pending.status_code, 409, pending.get_json())
        denied = self.client.post(
            "/api/v1/meetings",
            headers=self.auth("customer@example.com"),
            json=payload,
        )
        self.assertEqual(denied.status_code, 403, denied.get_json())

    def test_repeating_meeting_schedule_does_not_repeat_side_effects(self):
        created = self.create_ticket(self.auth("customer@example.com"), "PRODUCT_ENQUIRY")
        ticket_id = created.get_json()["ticket"]["id"]
        headers = self.auth("sales@example.com")
        start = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
        payload = {"ticket_id": ticket_id, "starts_at": start, "duration_minutes": 45}

        with patch("app.api.send_ticket_email", return_value=True) as send_email, \
                patch("app.realtime.emit_to_user") as emit_user, \
                patch("app.realtime.emit_to_department") as emit_department:
            first = self.client.post("/api/v1/meetings", headers=headers, json=payload)
            self.assertEqual(first.status_code, 201, first.get_json())
            notification_count = Notification.query.filter_by(ticket_id=ticket_id).count()

            second = self.client.post("/api/v1/meetings", headers=headers, json=payload)
            self.assertEqual(second.status_code, 200, second.get_json())

            self.assertTrue(first.get_json()["created"])
            self.assertFalse(second.get_json()["created"])
            self.assertEqual(first.get_json()["meeting"]["id"], second.get_json()["meeting"]["id"])
            self.assertEqual(Meeting.query.filter_by(ticket_id=ticket_id).count(), 1)
            self.assertEqual(Notification.query.filter_by(ticket_id=ticket_id).count(), notification_count)
            send_email.assert_called_once()
            self.assertEqual(
                sum(call.args[1] == "meeting_scheduled" for call in emit_user.call_args_list),
                1,
            )
            self.assertEqual(
                sum(call.args[1] == "meeting_scheduled" for call in emit_department.call_args_list),
                1,
            )

    def test_logout_revokes_access_token(self):
        headers = self.auth("customer@example.com")
        me = self.client.get("/api/v1/auth/me", headers=headers)
        self.assertEqual(me.status_code, 200)
        logout = self.client.post("/api/v1/auth/logout", headers=headers)
        self.assertEqual(logout.status_code, 200)
        self.assertEqual(self.client.get("/api/v1/auth/me", headers=headers).status_code, 401)

    def test_profile_and_smtp_settings_do_not_expose_personal_mail_configuration(self):
        for email in (
            "sales@example.com",
            "maintenance@example.com",
            "support@example.com",
            "customer@example.com",
        ):
            headers = self.auth(email)
            profile = self.client.get("/api/v1/auth/me", headers=headers)
            self.assertEqual(profile.status_code, 200, profile.get_json())
            self.assertNotIn("smtp_email", profile.get_json())
            self.assertNotIn("smtp_configured", profile.get_json())
            response = self.client.put(
                "/api/v1/auth/smtp-settings",
                headers=headers,
                json={
                    "smtp_email": "agent@gmail.com",
                    "smtp_password": "abcd efgh ijkl mnop",
                },
            )
            self.assertEqual(response.status_code, 404)

    def test_staff_email_uses_system_smtp_configuration(self):
        self.app.config.update(
            MAIL_USERNAME="nexus@example.com",
            MAIL_PASSWORD="system-app-password",
            MAIL_DEFAULT_SENDER="Nexus CRM <nexus@example.com>",
        )
        with patch("app.services.mail.send") as mail_send:
            sent = send_user_email(
                self.admin.email,
                "Sales update",
                "A sales update.",
            )

        self.assertTrue(sent)
        self.assertEqual(mail_send.call_args.args[0].sender, "Nexus CRM <nexus@example.com>")

    def test_refresh_rotates_refresh_token(self):
        login = self.client.post("/api/v1/auth/login", json={
            "email": "customer@example.com",
            "password": "Valid-Crm-Password-123",
        }).get_json()
        refreshed = self.client.post("/api/v1/auth/token/refresh/", json={"refresh": login["refresh"]})
        self.assertEqual(refreshed.status_code, 200, refreshed.get_json())
        self.assertIn("refresh", refreshed.get_json())
        rejected = self.client.post("/api/v1/auth/token/refresh/", json={"refresh": login["refresh"]})
        self.assertEqual(rejected.status_code, 401)

    def test_password_reset_link_is_single_use(self):
        request = self.client.post("/api/v1/auth/password-reset", json={"email": "customer@example.com"})
        self.assertEqual(request.status_code, 200)
        link = request.get_json()["development_reset_url"]
        token = parse_qs(urlparse(link).query)["token"][0]
        reset = self.client.post("/api/v1/auth/password-reset/confirm", json={
            "token": token,
            "password": "Changed-Crm-Password-456",
        })
        self.assertEqual(reset.status_code, 200)
        repeated = self.client.post("/api/v1/auth/password-reset/confirm", json={
            "token": token,
            "password": "Third-Crm-Password-789",
        })
        self.assertEqual(repeated.status_code, 400)
        login = self.client.post("/api/v1/auth/login", json={
            "email": "customer@example.com",
            "password": "Changed-Crm-Password-456",
        })
        self.assertEqual(login.status_code, 200)

    def test_customer_cannot_see_internal_ticket_comments(self):
        response = self.create_ticket(self.auth("customer@example.com"), "PRODUCT_ENQUIRY")
        ticket_id = response.get_json()["ticket"]["id"]
        admin_headers = self.auth("admin@example.com")
        internal = self.client.post(f"/api/v1/tickets/{ticket_id}/comments", headers=admin_headers, json={
            "body": "Private admin-only note.",
            "is_internal": True,
        })
        self.assertEqual(internal.status_code, 403)
        customer_details = self.client.get(f"/api/v1/tickets/{ticket_id}", headers=self.auth("customer@example.com"))
        self.assertEqual(customer_details.status_code, 200)
        self.assertEqual(customer_details.get_json()["comments"], [])

    def test_staff_status_update_does_not_send_ticket_details_to_main_admin(self):
        ticket = self.create_ticket(
            self.auth("customer@example.com"), "PRODUCT_ENQUIRY"
        ).get_json()["ticket"]
        headers = self.auth("sales@example.com")

        with patch("app.api.send_user_email", return_value=True) as send_user_email, \
                patch("app.api.send_assignee_email", return_value=True):
            response = self.client.patch(
                f"/api/v1/tickets/{ticket['id']}",
                headers=headers,
                json={"status": "IN_PROGRESS"},
            )

        self.assertEqual(response.status_code, 200, response.get_json())
        send_user_email.assert_not_called()

    def test_staff_ticket_comment_does_not_send_ticket_details_to_main_admin(self):
        ticket = self.create_ticket(
            self.auth("customer@example.com"), "PRODUCT_ENQUIRY"
        ).get_json()["ticket"]
        headers = self.auth("sales@example.com")
        comment = "The customer has confirmed the requested product details."

        with patch("app.api.send_user_email", return_value=True) as send_user_email, \
                patch("app.api.send_ticket_email", return_value=True):
            response = self.client.post(
                f"/api/v1/tickets/{ticket['id']}/comments",
                headers=headers,
                json={"body": comment},
            )

        self.assertEqual(response.status_code, 201, response.get_json())
        send_user_email.assert_not_called()

    def test_only_main_admin_can_delete_inactive_user_and_history_is_retained(self):
        deleted_customer = self.create_user(
            "Deleted Customer", "deleted.customer@example.com", "CUSTOMER", None
        )
        ticket = Ticket(
            ticket_number="TKTDELETED001",
            customer=deleted_customer,
            issue_category="PRODUCT_ENQUIRY",
            subject="Retained ticket history",
            description="Ticket details are retained.",
            priority="MEDIUM",
            status="NEW",
            department_id=self.sales.department_id,
        )
        db.session.add(ticket)
        db.session.flush()
        comment = TicketComment(
            ticket_id=ticket.id,
            author_id=deleted_customer.id,
            body="Retained comment history.",
        )
        db.session.add(comment)
        deleted_customer.is_active = False
        db.session.commit()

        denied = self.client.delete(
            f"/api/v1/admin/users/{deleted_customer.id}",
            headers=self.auth("sales@example.com"),
        )
        self.assertEqual(denied.status_code, 403)
        self.assertIsNotNone(db.session.get(User, deleted_customer.id))

        deleted = self.client.delete(
            f"/api/v1/admin/users/{deleted_customer.id}",
            headers=self.auth("admin@example.com"),
        )
        self.assertEqual(deleted.status_code, 200, deleted.get_json())
        self.assertIsNone(db.session.get(User, deleted_customer.id))
        retained_ticket = db.session.get(Ticket, ticket.id)
        retained_comment = db.session.get(TicketComment, comment.id)
        self.assertIsNone(retained_ticket.customer_id)
        self.assertIsNone(retained_comment.author_id)
        self.assertIsNone(retained_ticket.to_dict()["customer"])
        self.assertIsNone(retained_comment.to_dict()["author"])

    def test_cannot_delete_active_or_main_admin_account(self):
        active_customer = self.create_user(
            "Active Customer", "active.customer@example.com", "CUSTOMER", None
        )
        headers = self.auth("admin@example.com")
        active_delete = self.client.delete(
            f"/api/v1/admin/users/{active_customer.id}", headers=headers
        )
        self.assertEqual(active_delete.status_code, 409)

        admin = User.query.filter_by(email="admin@example.com").one()
        admin_delete = self.client.delete(
            f"/api/v1/admin/users/{admin.id}", headers=headers
        )
        self.assertEqual(admin_delete.status_code, 403)

    def test_public_feedback_includes_approved_reviews_only_in_list_and_summary(self):
        db.session.add_all([
            FeedbackReview(customer_id=self.customer.id, comment="Approved, wonderful.", rating=5, status="approved"),
            FeedbackReview(customer_id=self.customer.id, comment="Approved, good.", rating=3, status="approved"),
            FeedbackReview(customer_id=self.customer.id, comment="Awaiting review.", rating=1, status="pending"),
            FeedbackReview(customer_id=self.customer.id, comment="Not public.", rating=1, status="rejected"),
        ])
        db.session.commit()

        response = self.client.get("/api/v1/feedback/public")

        self.assertEqual(response.status_code, 200, response.get_json())
        payload = response.get_json()
        self.assertEqual(payload["total_reviews"], 2)
        self.assertEqual(payload["average_rating"], 4.0)
        self.assertEqual(payload["total"], 2)
        self.assertEqual({review["comment"] for review in payload["results"]}, {
            "Approved, wonderful.", "Approved, good.",
        })
        self.assertNotIn("customer_id", payload["results"][0])
        self.assertNotIn("email", payload["results"][0])
        self.assertEqual(payload["results"][0]["display_name"], "Anonymous customer")

        filtered = self.client.get("/api/v1/feedback/public?rating=5")
        self.assertEqual(filtered.status_code, 200)
        self.assertEqual(filtered.get_json()["total_reviews"], 2)
        self.assertEqual(filtered.get_json()["total"], 1)

    def test_feedback_submission_requires_customer_and_uses_authenticated_identity(self):
        response = self.client.post(
            "/api/v1/feedback",
            json={"rating": 4, "comment": "A customer review."},
        )
        self.assertEqual(response.status_code, 401)

        customer_id = self.customer.id
        headers = self.auth("customer@example.com")
        response = self.client.post(
            "/api/v1/feedback",
            headers=headers,
            json={
                "rating": 4,
                "comment": "  A customer review.  ",
                "title": "  Helpful service  ",
                "customer_id": self.admin.id,
                "display_name": "A. Customer",
            },
        )
        self.assertEqual(response.status_code, 201, response.get_json())
        review_id = response.get_json()["review"]["id"]
        review = db.session.get(FeedbackReview, review_id)
        self.assertEqual(review.customer_id, customer_id)
        self.assertEqual(review.comment, "A customer review.")
        self.assertEqual(review.title, "Helpful service")
        self.assertEqual(review.status, "pending")
        self.assertEqual(review.display_name, "A. Customer")

        other_customer = self.create_user("Another Customer", "another@example.com", "CUSTOMER", None)
        db.session.commit()
        other_history = self.client.get(
            "/api/v1/feedback/mine",
            headers=self.auth("another@example.com"),
        )
        self.assertEqual(other_history.status_code, 200)
        self.assertEqual(other_history.get_json()["total"], 0)
        customer_history = self.client.get("/api/v1/feedback/mine", headers=headers)
        self.assertEqual(customer_history.get_json()["results"][0]["id"], review_id)
        self.assertNotIn("customer_id", customer_history.get_json()["results"][0])
        self.assertNotEqual(other_customer.id, customer_id)

    def test_feedback_submission_validates_rating_comment_and_lengths(self):
        headers = self.auth("customer@example.com")
        for rating in (0, 6, True, 3.5, "5"):
            response = self.client.post(
                "/api/v1/feedback",
                headers=headers,
                json={"rating": rating, "comment": "Feedback"},
            )
            self.assertEqual(response.status_code, 400, response.get_json())
        for comment in ("   ", "x" * 3001):
            response = self.client.post(
                "/api/v1/feedback",
                headers=headers,
                json={"rating": 5, "comment": comment},
            )
            self.assertEqual(response.status_code, 400, response.get_json())
        response = self.client.post(
            "/api/v1/feedback",
            headers=headers,
            json={"rating": 5, "comment": "Feedback", "title": "t" * 121},
        )
        self.assertEqual(response.status_code, 400, response.get_json())
        response = self.client.post(
            "/api/v1/feedback",
            headers=headers,
            json={"rating": 5, "comment": "Contact me at person@example.com"},
        )
        self.assertEqual(response.status_code, 400, response.get_json())
        self.assertEqual(FeedbackReview.query.count(), 0)

    def test_public_feedback_redacts_email_and_credentials_defensively(self):
        db.session.add(FeedbackReview(
            customer_id=self.customer.id,
            comment="Helpful support. Contact person@example.com; password=DoNotShare123",
            rating=5,
            status="approved",
            display_name="reviewer@example.com",
        ))
        db.session.commit()

        response = self.client.get("/api/v1/feedback/public")

        self.assertEqual(response.status_code, 200)
        review = response.get_json()["results"][0]
        self.assertNotIn("person@example.com", review["comment"])
        self.assertNotIn("DoNotShare123", review["comment"])
        self.assertNotIn("reviewer@example.com", review["display_name"])
        self.assertGreaterEqual(review["comment"].count("[redacted]"), 2)
        self.assertEqual(review["display_name"], "[redacted]")

    def test_only_main_admin_can_moderate_and_moderation_cannot_rewrite_feedback(self):
        customer_headers = self.auth("customer@example.com")
        submitted = self.client.post(
            "/api/v1/feedback",
            headers=customer_headers,
            json={"rating": 5, "comment": "Original customer wording.", "title": "Original"},
        )
        review_id = submitted.get_json()["review"]["id"]
        self.assertEqual(
            self.client.get(
                "/api/v1/admin/feedback",
                headers=self.auth("sales@example.com"),
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.patch(
                f"/api/v1/admin/feedback/{review_id}",
                headers=customer_headers,
                json={"status": "approved"},
            ).status_code,
            403,
        )

        admin_headers = self.auth("admin@example.com")
        queue = self.client.get("/api/v1/admin/feedback?status=pending", headers=admin_headers)
        self.assertEqual(queue.status_code, 200, queue.get_json())
        self.assertEqual(queue.get_json()["total"], 1)
        approved = self.client.patch(
            f"/api/v1/admin/feedback/{review_id}",
            headers=admin_headers,
            json={"status": "approved", "comment": "Rewrite attempt."},
        )
        self.assertEqual(approved.status_code, 200, approved.get_json())
        review = db.session.get(FeedbackReview, review_id)
        self.assertEqual(review.status, "approved")
        self.assertEqual(review.comment, "Original customer wording.")
        self.assertIsNotNone(review.moderated_at)
        self.assertEqual(review.moderator_id, self.admin.id)
        public_review = self.client.get("/api/v1/feedback/public").get_json()["results"][0]
        self.assertEqual(public_review["comment"], "Original customer wording.")

        rejected = self.client.patch(
            f"/api/v1/admin/feedback/{review_id}",
            headers=admin_headers,
            json={"status": "rejected"},
        )
        self.assertEqual(rejected.status_code, 200)
        self.assertEqual(self.client.get("/api/v1/feedback/public").get_json()["total_reviews"], 0)

    def test_feedback_moderation_rejects_invalid_ids_status_and_handles_database_failure(self):
        admin_headers = self.auth("admin@example.com")
        for review_id, status in (("invalid", "approved"), ("0", "approved"), ("999999", "approved"), ("1", "pending")):
            response = self.client.patch(
                f"/api/v1/admin/feedback/{review_id}",
                headers=admin_headers,
                json={"status": status},
            )
            self.assertIn(response.status_code, (400, 404))
        response = self.client.get("/api/v1/feedback/public?rating=0")
        self.assertEqual(response.status_code, 400)

        customer_headers = self.auth("customer@example.com")
        with patch("app.api.db.session.commit", side_effect=SQLAlchemyError("database unavailable")):
            failed = self.client.post(
                "/api/v1/feedback",
                headers=customer_headers,
                json={"rating": 4, "comment": "Cannot save."},
            )
        self.assertEqual(failed.status_code, 503)
        self.assertEqual(failed.get_json(), {
            "error": "Feedback could not be submitted. Please try again later.",
        })


if __name__ == "__main__":
    unittest.main()
