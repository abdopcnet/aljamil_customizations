frappe.ui.form.on('Sales Invoice', {
	refresh(frm) {
		console.log(
			'KH Quick Pay: refresh on Sales Invoice',
			frm.doc.name,
			'docstatus:',
			frm.doc.docstatus,
		);

		// Only work after Submit
		if (frm.doc.docstatus !== 1) return;

		frm.add_custom_button(__('💰 تسجيل دفع (Popup)'), function () {
			open_quick_payment_dialog_for_so(frm);
		}).addClass('btn-danger');
	},
});

function open_quick_payment_dialog_for_so(frm) {
	const d = new frappe.ui.Dialog({
		title: __('تسجيل دفع لفاتورة المبيعات') + frm.doc.name,
		fields: [
			{
				fieldname: 'posting_date',
				fieldtype: 'Date',
				label: __('Posting Date'),
				reqd: 1,
				default: frappe.datetime.get_today(),
			},
			{
				fieldname: 'mode_of_payment',
                // ========================= إعدادات عامة =========================

                // اسم جدول الكشف في العميل (Customer)
                const CUSTOMER_EXAMS_CHILD_FIELD = "size_t";

                // لو عندك جدول كشوفات في الفاتورة نفسها (Sales Invoice) حط اسمه هنا
                const INVOICE_EXAMS_CHILD_FIELD = "custom_size"; // غيّره لاسم الفيلد الحقيقي أو سيبه

                // ماب من أسماء الحقول بين الفورم و الـ child doctype
                const EYE_EXAM_FIELDNAMES = {
                    date:      "date",
                    sph_r:     "sph_r",
                    cyl_r:     "cyl_r",
                    axis_r:    "axis_r",
                    add_r:     "add_r",
                    pd_r:      "pd_r",

                    sph_l:     "sph_l",
                    cyl_l:     "cyl_l",
                    axis_l:    "axis_l",
                    add_l:     "add_l",
                    pd_l:      "pd_l"
                };

                // ========================= زرار الكشف الطبي في فاتورة المبيعات =========================

                frappe.ui.form.on("Sales Invoice", {
                    refresh(frm) {
                        // نمسح الزرار القديم لو موجود
                        if (frm.page.eye_btn && !frm.page.eye_btn.is_destroyed) {
                            frm.page.eye_btn.remove();
                        }

                        // نضيف الزرار كل مرة
                        frm.page.eye_btn = frm.page.add_inner_button(
                            __("الكشف الطبي (Eye Prescription)"),
                            function () {
                                if (!frm.doc.customer) {
                                    frappe.msgprint({
                                        title: __("تنبيه"),
                                        message: __("من فضلك اختر العميل أولاً قبل فتح كشف النظر."),
                                        indicator: "orange"
                                    });
                                    return;
                                }
                                open_eye_dialog(frm);
                            }
                        ).addClass("btn-primary");
                    }
                });

                // ========================= الدialog الرئيسي =========================

                function open_eye_dialog(frm) {
                    // Ensure metas are loaded
                    frappe.model.with_doctype("Customer", () => {
                        frappe.model.with_doctype("Eye Prescription", () => {
                             _open_dialog_logic(frm);
                        });
                    });
                }

                async function _open_dialog_logic(frm) {
                    // نبني الدialog
                    const d = new frappe.ui.Dialog({
                        title: __("الكشف الطبي (Eye Prescription) - فاتورة المبيعات"),
                        size: "large",
                        fields: [
                            { fieldtype: "Section Break", label: "كشف جديد 🔍" },

                            {
                                fieldname: "exam_date",
                                fieldtype: "Date",
                                label: __("تاريخ الكشف"),
                                reqd: 1,
                                default: frm.doc.posting_date || frappe.datetime.get_today() // Use posting_date for Invoice
                            },

                            // Right / Left منظمين: كل عين فى كولوم لوحدها
                            { fieldtype: "Column Break" },

                            { fieldname: "sph_r", label: "SPH-R", fieldtype: "Data" },
                            { fieldname: "cyl_r", label: "CYL-R", fieldtype: "Data" },
                            { fieldname: "axis_r", label: "Axis-R", fieldtype: "Data" },
                            { fieldname: "add_r", label: "ADD-R", fieldtype: "Data" },
                            { fieldname: "pd_r",  label: "PD-R",  fieldtype: "Data" },

                            { fieldtype: "Column Break" },

                            { fieldname: "sph_l", label: "SPH-L", fieldtype: "Data" },
                            { fieldname: "cyl_l", label: "CYL-L", fieldtype: "Data" },
                            { fieldname: "axis_l", label: "Axis-L", fieldtype: "Data" },
                            { fieldname: "add_l", label: "ADD-L", fieldtype: "Data" },
                            { fieldname: "pd_l",  label: "PD-L",  fieldtype: "Data" },

                            { fieldtype: "Section Break", label: "📜 الكشوفات المسجلة في هذه الفاتورة" },
                            {
                                fieldname: "invoice_exams_html",
                                fieldtype: "HTML"
                            },

                            { fieldtype: "Section Break", label: "📂 الكشوفات السابقة لهذا العميل" },
                            {
                                fieldname: "previous_exams_html",
                                fieldtype: "HTML"
                            },

                            { fieldtype: "Section Break" }
                        ],
                        primary_action_label: __("حفظ الكشف في الفاتورة"),
                        primary_action: function () {
                            save_new_exam(frm, d);
                        }
                    });

                    // نرسم جدول "الكشوفات المسجلة في هذه الفاتورة"
                    render_invoice_exam_table(frm, d);

                    // Discover Table Name
                    const cust_meta = frappe.get_meta("Customer");
                    if(cust_meta) {
                        const field = cust_meta.fields.find(df => df.fieldtype === 'Table' && df.options === 'Eye Prescription');
                        if(field) {
                             d.custom_eye_table_field = field.fieldname;
                        }
                    }

                    // Discover Column Names
                    const child_meta = frappe.get_meta("Eye Prescription");
                    if(child_meta) {
                        const label_map = {
                            'sph-r': 'sph_r', 'cyl-r': 'cyl_r', 'axis-r': 'axis_r', 'add-r': 'add_r', 'pd-r': 'pd_r',
                            'sph-l': 'sph_l', 'cyl-l': 'cyl_l', 'axis-l': 'axis_l', 'add-l': 'add_l', 'pd-l': 'pd_l',
                            'date': 'date'
                        };
                        const new_map = {};
                        child_meta.fields.forEach(df => {
                            const label = (df.label || '').toLowerCase();
                            for (const k in label_map) {
                                if (label.includes(k) || (k==='date' && (label==='date' || label==='تاريخ'))) {
                                     new_map[label_map[k]] = df.fieldname;
                                }
                            }
                        });

                        if (Object.keys(new_map).length > 0) {
                            d.custom_eye_col_map = new_map;
                        }
                    }

                    // نحاول تحميل الكشوفات السابقة للعميل
                    load_previous_eye_exams(frm, d);

                    // blur active element to avoid aria-hidden focus issues when hiding previous modal
                    try { document.activeElement && document.activeElement.blur && document.activeElement.blur(); } catch (e) {}
                    // give browser a moment to apply blur before showing new modal
                    await new Promise((res) => setTimeout(res, 50));
                    d.show();
                }

                // ========================= جدول الكشوفات في هذه الفاتورة =========================

                function render_invoice_exam_table(frm, dialog) {
                    const wrapper = dialog.fields_dict.invoice_exams_html.$wrapper;
                    wrapper.empty();

                    // هنخزن الكشوفات الخاصة بهذه الفاتورة في Array داخل الدialog
                    dialog.invoice_exams = dialog.invoice_exams || [];

                    const exams = dialog.invoice_exams;

                    let html = `
                        <div class="mb-2 text-muted small">
                            يمكنك إضافة كشف واحد فقط لهذه الفاتورة.
                        </div>
                        <table class="table table-bordered table-condensed" style="table-layout: fixed; width: 100%;">
                            <thead>
                                <tr style="background:#f5f5f5;">
                                    <th style="width:40px;">#</th>
                                    <th style="width:100px;">تاريخ</th>
                                    <th>SPH-R</th>
                                    <th>CYL-R</th>
                                    <th>Axis-R</th>
                                    <th>ADD-R</th>
                                    <th>PD-R</th>
                                    <th>SPH-L</th>
                                    <th>CYL-L</th>
                                    <th>Axis-L</th>
                                    <th>ADD-L</th>
                                    <th>PD-L</th>
                                    <th style="width:80px;">إجراء</th>
                                </tr>
                            </thead>
                            <tbody>
                    `;

                    if (!exams.length) {
                        html += `
                            <tr>
                                <td colspan="13" class="text-center text-muted">
                                    لا يوجد كشف مسجل بعد لهذه الفاتورة.
                                </td>
                            </tr>
                        `;
                    } else {
                        exams.forEach((exam, idx) => {
                            html += `
                                <tr>
                                    <td>${idx + 1}</td>
                                    <td style="word-wrap: break-word;">${frappe.format(exam.date, { fieldtype: "Date" }) || ""}</td>
                                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(exam.sph_r || "")}</td>
                                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(exam.cyl_r || "")}</td>
                                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(exam.axis_r || "")}</td>
                                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(exam.add_r || "")}</td>
                                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(exam.pd_r || "")}</td>
                                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(exam.sph_l || "")}</td>
                                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(exam.cyl_l || "")}</td>
                                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(exam.axis_l || "")}</td>
                                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(exam.add_l || "")}</td>
                                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(exam.pd_l || "")}</td>
                                    <td>
                                        <button class="btn btn-xs btn-danger si-eye-remove" data-idx="${idx}">
                                            ${__("حذف")}
                                        </button>
                                    </td>
                                </tr>
                            `;
                        });
                    }

                    html += `
                            </tbody>
                        </table>
                    `;

                    wrapper.html(html);

                    // حدث حذف الصف
                    wrapper.find(".si-eye-remove").on("click", function () {
                        const idx = parseInt($(this).attr("data-idx"), 10);
                        dialog.invoice_exams.splice(idx, 1);
                        render_invoice_exam_table(frm, dialog);
                    });
                }

                // يقرأ القيم من الفورم "كشف جديد" ويحطها في Array الخاصة بالفاتورة
                function set_exam_on_sales_invoice(dialog) {
                    const values = dialog.get_values();

                    const exam_data = {
                        date:  values.exam_date || frappe.datetime.get_today(),
                        sph_r: values.sph_r,
                        cyl_r: values.cyl_r,
                        axis_r: values.axis_r,
                        add_r: values.add_r,
                        pd_r:  values.pd_r,

                        sph_l: values.sph_l,
                        cyl_l: values.cyl_l,
                        axis_l: values.axis_l,
                        add_l: values.add_l,
                        pd_l:  values.pd_l
                    };

                    dialog.invoice_exams = dialog.invoice_exams || [];

                    if (dialog.invoice_exams.length >= 1) {
                        frappe.throw(__("لا يمكن إضافة أكثر من صف واحد في جدول الكشوفات لهذه الفاتورة."));
                    }

                    dialog.invoice_exams.push(exam_data);
                }

                // ========================= حفظ كشف جديد (على العميل وعلى الفاتورة) =========================

                function save_new_exam(frm, dialog) {
                    const v = dialog.get_values();
                    if (!v) return;

                    // أولاً: نحط الكشف في جدول الفاتورة (Array) ونمنع أكتر من واحد
                    try {
                        if (!dialog.invoice_exams || !dialog.invoice_exams.length) {
                            set_exam_on_sales_invoice(dialog);
                        }
                    } catch (e) {
                        frappe.msgprint({
                            title: __("تحذير"),
                            message: e.message || e,
                            indicator: "orange"
                        });
                        return;
                    }

                    const exam = dialog.invoice_exams[0];

                    // تانيًا: نحفظ الكشف في جدول العميل (Customer.child table) لو عندك صلاحية
                    frappe.call({
                        method: "frappe.client.get",
                        args: {
                            doctype: "Customer",
                            name: frm.doc.customer
                        },
                        callback(r) {
                            const customer = r.message;
                            if (!customer) return;

                            const target_field = dialog.custom_eye_table_field || CUSTOMER_EXAMS_CHILD_FIELD;
                            const FN = dialog.custom_eye_col_map || EYE_EXAM_FIELDNAMES;

                            customer[target_field] =
                                customer[target_field] || [];

                            // Check for duplicates before pushing
                            const is_duplicate = customer[target_field].some(existing =>
                                existing[FN.date] === exam.date &&
                                existing[FN.sph_r] === exam.sph_r &&
                                existing[FN.cyl_r] === exam.cyl_r &&
                                existing[FN.sph_l] === exam.sph_l &&
                                existing[FN.cyl_l] === exam.cyl_l
                            );

                            let row_to_update;
                            if (!is_duplicate) {
                                // نضيف صف جديد في جدول العميل
                                row_to_update = {
                                    doctype: "Eye Prescription",
                                    parent: customer.name,
                                    parenttype: "Customer",
                                    parentfield: target_field,
                                    invoice: frm.doc.name || ""
                                };
                                customer[target_field].push(row_to_update);
                            } else {
                                // If duplicate, find existing and set invoice link, but do not show popup
                                row_to_update = customer[target_field].find(existing =>
                                    existing[FN.date] === exam.date &&
                                    existing[FN.sph_r] === exam.sph_r &&
                                    existing[FN.cyl_r] === exam.cyl_r &&
                                    existing[FN.sph_l] === exam.sph_l &&
                                    existing[FN.cyl_l] === exam.cyl_l
                                );
                                if (row_to_update) row_to_update.invoice = frm.doc.name || "";
                            }

                            row_to_update[FN.date]   = exam.date;
                            row_to_update[FN.sph_r]  = exam.sph_r;
                            row_to_update[FN.cyl_r]  = exam.cyl_r;
                            row_to_update[FN.axis_r] = exam.axis_r;
                            row_to_update[FN.add_r]  = exam.add_r;
                            row_to_update[FN.pd_r]   = exam.pd_r;

                            row_to_update[FN.sph_l]  = exam.sph_l;
                            row_to_update[FN.cyl_l]  = exam.cyl_l;
                            row_to_update[FN.axis_l] = exam.axis_l;
                            row_to_update[FN.add_l]  = exam.add_l;
                            row_to_update[FN.pd_l]   = exam.pd_l;

                            frappe.call({
                                method: "frappe.client.save",
                                args: { doc: customer },
                                callback() {
                                    // Show a simple saved message and continue silently if duplicate
                                    frappe.msgprint({
                                        title: __("تم الحفظ"),
                                        message: __("تم حفظ/تحديث الكشف في الفاتورة وفي ملف العميل."),
                                        indicator: "green"
                                    });
                                    finish_save();
                                }
                            });

                            function finish_save() {
                                // نحاول نربط الكشف في جدول الفاتورة الحقيقي
                                try {
                                    link_exam_to_sales_invoice_child(frm, exam, dialog.custom_eye_col_map);
                                } catch (e) {
                                    console.warn('Could not link exam to invoice child table', e);
                                    frappe.msgprint({
                                        title: __('تنبيه'),
                                        message: __('تعذر ربط الكشف بجدول الفاتورة (ربما الوثيقة مُقيدة).'),
                                        indicator: 'orange'
                                    });
                                }

                                // نرسم الجدول تاني
                                render_invoice_exam_table(frm, dialog);

                                // نعيد تحميل الكشوفات السابقة
                                load_previous_eye_exams(frm, dialog);
                            }
                        },
                        error(err) {
                            console.error("Error saving exam on customer", err);
                            frappe.msgprint({
                                title: __("خطأ"),
                                message: __("تعذر حفظ الكشف في ملف العميل (ربما مشكلة صلاحيات)."),
                                indicator: "red"
                            });

                            // حتى لو فشل حفظه في العميل، نحتفظ به على مستوى الفاتورة فقط
                            try {
                                link_exam_to_sales_invoice_child(frm, exam, dialog.custom_eye_col_map);
                            } catch (e) {
                                console.warn('Could not link exam to invoice child table (error path)', e);
                                frappe.msgprint({
                                    title: __('تنبيه'),
                                    message: __('تعذر ربط الكشف بجدول الفاتورة (ربما الوثيقة مُقيدة).'),
                                    indicator: 'orange'
                                });
                            }
                            render_invoice_exam_table(frm, dialog);
                        }
                    });
                }

                // ربط الكشف بجدول child في الفاتورة لو الفيلد موجود
                function link_exam_to_sales_invoice_child(frm, exam, field_map) {
                    const fn = INVOICE_EXAMS_CHILD_FIELD;
                    if (!fn || !frm.fields_dict[fn]) {
                        console.warn("Eye Prescription child table not found on Sales Invoice, skipping link.");
                        return;
                    }

                    frm.doc[fn] = frm.doc[fn] || [];

                    // نسمح بصف واحد فقط
                    if (frm.doc[fn].length > 1) {
                        frappe.throw(__("لا يمكن إضافة أكثر من صف واحد في جدول الكشوفات للفاتورة."));
                    }

                    let row;
                    if (frm.doc[fn].length === 0) {
                        row = frm.add_child(fn);
                    } else {
                        row = frm.doc[fn][0];
                    }

                    const FN = field_map || EYE_EXAM_FIELDNAMES;

                    row[FN.date]   = exam.date;
                    row[FN.sph_r]  = exam.sph_r;
                    row[FN.cyl_r]  = exam.cyl_r;
                    row[FN.axis_r] = exam.axis_r;
                    row[FN.add_r]  = exam.add_r;
                    row[FN.pd_r]   = exam.pd_r;

                    row[FN.sph_l]  = exam.sph_l;
                    row[FN.cyl_l]  = exam.cyl_l;
                    row[FN.axis_l] = exam.axis_l;
                    row[FN.add_l]  = exam.add_l;
                    row[FN.pd_l]   = exam.pd_l;

                    frm.refresh_field(fn);
                }

                // ========================= تحميل الكشوفات السابقة للعميل =========================

                function load_previous_eye_exams(frm, dialog) {
                    const wrapper = dialog.fields_dict.previous_exams_html.$wrapper;
                    wrapper.empty();

                    if (!frm.doc.customer) {
                        wrapper.html(`<div class="text-muted small">من فضلك اختر العميل أولاً.</div>`);
                        return;
                    }

                    // نحاول نجيب الكشوفات من جدول العميل نفسه
                    frappe.call({
                        method: "frappe.client.get",
                        args: {
                            doctype: "Customer",
                            name: frm.doc.customer
                        },
                        callback(r) {
                            const customer = r.message;
                            if (!customer) {
                                wrapper.html(`<div class="text-muted small">لم يتم العثور على بيانات العميل.</div>`);
                                return;
                            }

                            const target_field = dialog.custom_eye_table_field || CUSTOMER_EXAMS_CHILD_FIELD;

                            let arr = customer[target_field] || [];

                            const FN = dialog.custom_eye_col_map || EYE_EXAM_FIELDNAMES;

                            if (!arr.length) {
                                wrapper.html(`<div class="text-muted small">لا توجد كشوفات سابقة لهذا العميل.</div>`);
                                return;
                            }

                            let html = `
                                <table class="table table-bordered table-condensed" style="table-layout: fixed; width: 100%;">
                                    <thead>
                                        <tr style="background:#f5f5f5;">
                                            <th style="width:40px;">#</th>
                                            <th style="width:100px;">تاريخ</th>
                                            <th>SPH-R</th>
                                            <th>CYL-R</th>
                                            <th>Axis-R</th>
                                            <th>ADD-R</th>
                                            <th>PD-R</th>
                                            <th>SPH-L</th>
                                            <th>CYL-L</th>
                                            <th>Axis-L</th>
                                            <th>ADD-L</th>
                                            <th>PD-L</th>
                                            <th style="width:80px;">اختيار</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                            `;

                            arr.forEach((row, idx) => {
                                html += `
                                    <tr>
                                        <td>${idx + 1}</td>
                                        <td style="word-wrap: break-word;">${frappe.format(row[FN.date], { fieldtype: "Date" }) || ""}</td>
                                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(row[FN.sph_r] || "")}</td>
                                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(row[FN.cyl_r] || "")}</td>
                                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(row[FN.axis_r] || "")}</td>
                                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(row[FN.add_r] || "")}</td>
                                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(row[FN.pd_r] || "")}</td>

                                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(row[FN.sph_l] || "")}</td>
                                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(row[FN.cyl_l] || "")}</td>
                                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(row[FN.axis_l] || "")}</td>
                                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(row[FN.add_l] || "")}</td>
                                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(row[FN.pd_l] || "")}</td>

                                        <td>
                                            <button class="btn btn-xs btn-primary si-eye-use" data-idx="${idx}">
                                                ${__("استخدام")}
                                            </button>
                                        </td>
                                    </tr>
                                `;
                            });

                            html += `
                                    </tbody>
                                </table>
                            `;

                            wrapper.html(html);

                            // عند الضغط على "استخدام" ننسخ الكشف إلى الجزء العلوي وإلى جدول الفاتورة
                            wrapper.find(".si-eye-use").on("click", function () {
                                const idx = parseInt($(this).attr("data-idx"), 10);
                                const row = arr[idx];

                                const exam = {
                                    date:  row[FN.date],
                                    sph_r: row[FN.sph_r],
                                    cyl_r: row[FN.cyl_r],
                                    axis_r: row[FN.axis_r],
                                    add_r: row[FN.add_r],
                                    pd_r:  row[FN.pd_r],

                                    sph_l: row[FN.sph_l],
                                    cyl_l: row[FN.cyl_l],
                                    axis_l: row[FN.axis_l],
                                    add_l: row[FN.add_l],
                                    pd_l:  row[FN.pd_l]
                                };

                                // نملأ الفورم العلوي بالكشف المختار
                                dialog.set_value("exam_date", exam.date);
                                dialog.set_value("sph_r", exam.sph_r);
                                dialog.set_value("cyl_r", exam.cyl_r);
                                dialog.set_value("axis_r", exam.axis_r);
                                dialog.set_value("add_r", exam.add_r);
                                dialog.set_value("pd_r", exam.pd_r);

                                dialog.set_value("sph_l", exam.sph_l);
                                dialog.set_value("cyl_l", exam.cyl_l);
                                dialog.set_value("axis_l", exam.axis_l);
                                dialog.set_value("add_l", exam.add_l);
                                dialog.set_value("pd_l", exam.pd_l);

                                // نخلي جدول هذه الفاتورة يحتوي هذا الكشف فقط
                                dialog.invoice_exams = [exam];
                                render_invoice_exam_table(frm, dialog);

                                // ونربطه بجدول الفاتورة (محاولة هادئة، لا تعرض popup عند وجود الكشف مسبقًا)
                                try {
                                    link_exam_to_sales_invoice_child(frm, exam, dialog.custom_eye_col_map);
                                } catch (e) {
                                    console.warn('Could not link exam to invoice child table (use previous)', e);
                                }
                            });
                        },
                        error(err) {
                            console.error("Error loading previous eye exams", err);
                            wrapper.html(`
                                <div class="text-danger small">
                                    تعذر تحميل الكشوفات السابقة (صلاحيات أو مشكلة في الاتصال).
                                </div>
                            `);
                        }
                    });
                }

// ========================= زرار الكشف الطبي في أمر البيع =========================

frappe.ui.form.on("Sales Order", {
    refresh(frm) {
        // نمسح الزرار القديم لو موجود (عشان الـ refresh بيكرر بناء الهيدر)
        if (frm.page.eye_btn && !frm.page.eye_btn.is_destroyed) {
            frm.page.eye_btn.remove();
        }

        // نضيف الزرار كل مرة
        frm.page.eye_btn = frm.page.add_inner_button(
            __("الكشف الطبي (Eye Prescription)"),
            function () {
                if (!frm.doc.customer) {
                    frappe.msgprint({
                        title: __("تنبيه"),
                        message: __("من فضلك اختر العميل أولاً قبل فتح كشف النظر."),
                        indicator: "orange"
                    });
                    return;
                }
                open_eye_dialog(frm);
            }
        ).addClass("btn-primary");
    }
});

// ========================= الدialog الرئيسي =========================

function open_eye_dialog(frm) {
    // Ensure metas are loaded
    frappe.model.with_doctype("Customer", () => {
        frappe.model.with_doctype("Eye Prescription", () => {
             _open_dialog_logic(frm);
        });
    });
}

function _open_dialog_logic(frm) {
    // نبني الدialog
    const d = new frappe.ui.Dialog({
        title: __("الكشف الطبي (Eye Prescription)"),
        size: "large",
        fields: [
            { fieldtype: "Section Break", label: "كشف جديد 🔍" },

            {
                fieldname: "exam_date",
                fieldtype: "Date",
                label: __("تاريخ الكشف"),
                reqd: 1,
                default: frm.doc.transaction_date || frappe.datetime.get_today()
            },

            // Right / Left منظمين: كل عين فى كولوم لوحدها
            { fieldtype: "Column Break" },

            { fieldname: "sph_r", label: "SPH-R", fieldtype: "Data" },
            { fieldname: "cyl_r", label: "CYL-R", fieldtype: "Data" },
            { fieldname: "axis_r", label: "Axis-R", fieldtype: "Data" },
            { fieldname: "add_r", label: "ADD-R", fieldtype: "Data" },
            { fieldname: "pd_r",  label: "PD-R",  fieldtype: "Data" },

            { fieldtype: "Column Break" },

            { fieldname: "sph_l", label: "SPH-L", fieldtype: "Data" },
            { fieldname: "cyl_l", label: "CYL-L", fieldtype: "Data" },
            { fieldname: "axis_l", label: "Axis-L", fieldtype: "Data" },
            { fieldname: "add_l", label: "ADD-L", fieldtype: "Data" },
            { fieldname: "pd_l",  label: "PD-L",  fieldtype: "Data" },

            { fieldtype: "Section Break", label: "📜 الكشوفات المسجلة في هذا الأمر" },
            {
                fieldname: "order_exams_html",
                fieldtype: "HTML"
            },

            { fieldtype: "Section Break", label: "📂 الكشوفات السابقة لهذا العميل" },
            {
                fieldname: "previous_exams_html",
                fieldtype: "HTML"
            },

            { fieldtype: "Section Break" }
        ],
        primary_action_label: __("حفظ الكشف في أمر البيع"),
        primary_action: function () {
            save_new_exam(frm, d);
        }
    });

    // نرسم جدول "الكشوفات المسجلة في هذا الأمر" (سطر واحد فقط)
    render_order_exam_table(frm, d);

    // Discover Table Name
    const cust_meta = frappe.get_meta("Customer");
    if(cust_meta) {
        const field = cust_meta.fields.find(df => df.fieldtype === 'Table' && df.options === 'Eye Prescription');
        if(field) {
             d.custom_eye_table_field = field.fieldname;
        }
    }

    // Discover Column Names
    const child_meta = frappe.get_meta("Eye Prescription");
    if(child_meta) {
        const label_map = {
            'sph-r': 'sph_r', 'cyl-r': 'cyl_r', 'axis-r': 'axis_r', 'add-r': 'add_r', 'pd-r': 'pd_r',
            'sph-l': 'sph_l', 'cyl-l': 'cyl_l', 'axis-l': 'axis_l', 'add-l': 'add_l', 'pd-l': 'pd_l',
            'date': 'date'
        };
        const new_map = {};
        child_meta.fields.forEach(df => {
            const label = (df.label || '').toLowerCase();
            for (const k in label_map) {
                if (label.includes(k) || (k==='date' && (label==='date' || label==='تاريخ'))) {
                     new_map[label_map[k]] = df.fieldname;
                }
            }
        });

        if (Object.keys(new_map).length > 0) {
            d.custom_eye_col_map = new_map;
        }
    }

    // نحاول تحميل الكشوفات السابقة للعميل
    load_previous_eye_exams(frm, d);

    d.show();
}

// ========================= جدول الكشوفات في هذا الأمر =========================

function render_order_exam_table(frm, dialog) {
    const wrapper = dialog.fields_dict.order_exams_html.$wrapper;
    wrapper.empty();

    // هنخزن الكشوفات الخاصة بهذا الأمر في Array داخل الدialog
    dialog.order_exams = dialog.order_exams || [];

    const exams = dialog.order_exams;

    let html = `
        <div class="mb-2 text-muted small">
            يمكنك إضافة كشف واحد فقط لهذا الأمر. إذا أردت استبداله، امسح الصف الحالي أو استخدم كشف قديم من الأسفل.
        </div>
        <table class="table table-bordered table-condensed" style="table-layout: fixed; width: 100%;">
            <thead>
                <tr style="background:#f5f5f5;">
                    <th style="width:40px;">#</th>
                    <th style="width:100px;">تاريخ</th>
                    <th>SPH-R</th>
                    <th>CYL-R</th>
                    <th>Axis-R</th>
                    <th>ADD-R</th>
                    <th>PD-R</th>
                    <th>SPH-L</th>
                    <th>CYL-L</th>
                    <th>Axis-L</th>
                    <th>ADD-L</th>
                    <th>PD-L</th>
                    <th style="width:80px;">إجراء</th>
                </tr>
            </thead>
            <tbody>
    `;

    if (!exams.length) {
        html += `
            <tr>
                <td colspan="13" class="text-center text-muted">
                    لا يوجد كشف مسجل بعد لهذا الأمر.
                </td>
            </tr>
        `;
    } else {
        exams.forEach((exam, idx) => {
            html += `
                <tr>
                    <td>${idx + 1}</td>
                    <td style="word-wrap: break-word;">${frappe.format(exam.date, { fieldtype: "Date" }) || ""}</td>
                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(exam.sph_r || "")}</td>
                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(exam.cyl_r || "")}</td>
                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(exam.axis_r || "")}</td>
                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(exam.add_r || "")}</td>
                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(exam.pd_r || "")}</td>
                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(exam.sph_l || "")}</td>
                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(exam.cyl_l || "")}</td>
                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(exam.axis_l || "")}</td>
                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(exam.add_l || "")}</td>
                    <td style="word-wrap: break-word;">${frappe.utils.escape_html(exam.pd_l || "")}</td>
                    <td>
                        <button class="btn btn-xs btn-danger so-eye-remove" data-idx="${idx}">
                            ${__("حذف")}
                        </button>
                    </td>
                </tr>
            `;
        });
    }

    html += `
            </tbody>
        </table>
    `;

    wrapper.html(html);

    // حدث حذف الصف
    wrapper.find(".so-eye-remove").on("click", function () {
        const idx = parseInt($(this).attr("data-idx"), 10);
        dialog.order_exams.splice(idx, 1);
        render_order_exam_table(frm, dialog);
    });
}

// يقرأ القيم من الفورم "كشف جديد" ويحطها في Array الخاصة بالأمر
function set_exam_on_sales_order(dialog) {
    const values = dialog.get_values();

    const exam_data = {
        date:  values.exam_date || frappe.datetime.get_today(),
        sph_r: values.sph_r,
        cyl_r: values.cyl_r,
        axis_r: values.axis_r,
        add_r: values.add_r,
        pd_r:  values.pd_r,

        sph_l: values.sph_l,
        cyl_l: values.cyl_l,
        axis_l: values.axis_l,
        add_l: values.add_l,
        pd_l:  values.pd_l
    };

    dialog.order_exams = dialog.order_exams || [];

    if (dialog.order_exams.length >= 1) {
        // نمنع أكثر من صف
        frappe.throw(__("لا يمكن إضافة أكثر من صف واحد في جدول الكشوفات لهذا الأمر."));
    }

    dialog.order_exams.push(exam_data);
}

// ========================= حفظ كشف جديد (على العميل وعلى أمر البيع) =========================

function save_new_exam(frm, dialog) {
    const v = dialog.get_values();
    if (!v) return;

    // أولاً: نحط الكشف في جدول الأمر (Array) ونمنع أكتر من واحد
    try {
        if (!dialog.order_exams || !dialog.order_exams.length) {
            // لو مفيش صف حالياً، نضيف واحد من القيم اللي في الفورم
            set_exam_on_sales_order(dialog);
        }
    } catch (e) {
        // لو حصل throw من set_exam_on_sales_order
        frappe.msgprint({
            title: __("تحذير"),
            message: e.message || e,
            indicator: "orange"
        });
        return;
    }

    const exam = dialog.order_exams[0];

    // تانيًا: نحفظ الكشف في جدول العميل (Customer.child table) لو عندك صلاحية
    frappe.call({
        method: "frappe.client.get",
        args: {
            doctype: "Customer",
            name: frm.doc.customer
        },
        callback(r) {
            const customer = r.message;
            if (!customer) return;

            const target_field = dialog.custom_eye_table_field || CUSTOMER_EXAMS_CHILD_FIELD;
            const FN = dialog.custom_eye_col_map || EYE_EXAM_FIELDNAMES;

            customer[target_field] =
                customer[target_field] || [];

            const existing_row = customer[target_field].find(existing =>
                existing[FN.date] === exam.date &&
                existing[FN.sph_r] === exam.sph_r &&
                existing[FN.cyl_r] === exam.cyl_r &&
                existing[FN.sph_l] === exam.sph_l &&
                existing[FN.cyl_l] === exam.cyl_l
            );

            let row_to_update;
            if (!existing_row) {
                row_to_update = {
                    doctype: "Eye Prescription",
                    parent: customer.name,
                    parenttype: "Customer",
                    parentfield: target_field,
                    so: frm.doc.name || ""
                };
                customer[target_field].push(row_to_update);
            } else {
                row_to_update = existing_row;
                row_to_update.so = frm.doc.name || "";
            }

            row_to_update[FN.date]   = exam.date;
            row_to_update[FN.sph_r]  = exam.sph_r;
            row_to_update[FN.cyl_r]  = exam.cyl_r;
            row_to_update[FN.axis_r] = exam.axis_r;
            row_to_update[FN.add_r]  = exam.add_r;
            row_to_update[FN.pd_r]   = exam.pd_r;

            row_to_update[FN.sph_l]  = exam.sph_l;
            row_to_update[FN.cyl_l]  = exam.cyl_l;
            row_to_update[FN.axis_l] = exam.axis_l;
            row_to_update[FN.add_l]  = exam.add_l;
            row_to_update[FN.pd_l]   = exam.pd_l;

            frappe.call({
                method: "frappe.client.save",
                args: { doc: customer },
                callback() {
                    frappe.msgprint({
                        title: __("تم الحفظ"),
                        message: __("تم حفظ/تحديث الكشف في أمر البيع وفي ملف العميل."),
                        indicator: "green"
                    });
                    finish_save();
                }
            });

            function finish_save() {
                // نحاول نربط الكشف في جدول أمر البيع الحقيقي (لو موجود)
                link_exam_to_sales_order_child(frm, exam, dialog.custom_eye_col_map);

                // نرسم الجدول تاني
                render_order_exam_table(frm, dialog);

                // نعيد تحميل الكشوفات السابقة (عشان يظهر الكشف الجديد تحت)
                load_previous_eye_exams(frm, dialog);
            }
        },
        error(err) {
            console.error("Error saving exam on customer", err);
            frappe.msgprint({
                title: __("خطأ"),
                message: __("تعذر حفظ الكشف في ملف العميل (ربما مشكلة صلاحيات)."),
                indicator: "red"
            });

            // حتى لو فشل حفظه في العميل، نحتفظ به على مستوى أمر البيع فقط
            link_exam_to_sales_order_child(frm, exam, dialog.custom_eye_col_map);
            render_order_exam_table(frm, dialog);
        }
    });
}

// ربط الكشف بجدول child في أمر البيع لو الفيلد موجود
function link_exam_to_sales_order_child(frm, exam, field_map) {
    const fn = ORDER_EXAMS_CHILD_FIELD;
    if (!fn || !frm.fields_dict[fn]) {
        // مفيش جدول child فى أمر البيع أو الاسم مش مظبوط → نتجاهل
        console.warn("Eye Prescription child table not found on Sales Order, skipping link.");
        return;
    }

    frm.doc[fn] = frm.doc[fn] || [];

    // نسمح بصف واحد فقط
    if (frm.doc[fn].length > 1) {
        frappe.throw(__("لا يمكن إضافة أكثر من صف واحد في جدول الكشوفات لأمر البيع."));
    }

    let row;
    if (frm.doc[fn].length === 0) {
        row = frm.add_child(fn);
    } else {
        row = frm.doc[fn][0];
    }

    const FN = field_map || EYE_EXAM_FIELDNAMES;

    row[FN.date]   = exam.date;
    row[FN.sph_r]  = exam.sph_r;
    row[FN.cyl_r]  = exam.cyl_r;
    row[FN.axis_r] = exam.axis_r;
    row[FN.add_r]  = exam.add_r;
    row[FN.pd_r]   = exam.pd_r;

    row[FN.sph_l]  = exam.sph_l;
    row[FN.cyl_l]  = exam.cyl_l;
    row[FN.axis_l] = exam.axis_l;
    row[FN.add_l]  = exam.add_l;
    row[FN.pd_l]   = exam.pd_l;

    frm.refresh_field(fn);
}

// ========================= تحميل الكشوفات السابقة للعميل =========================

function load_previous_eye_exams(frm, dialog) {
    const wrapper = dialog.fields_dict.previous_exams_html.$wrapper;
    wrapper.empty();

    if (!frm.doc.customer) {
        wrapper.html(`<div class="text-muted small">من فضلك اختر العميل أولاً.</div>`);
        return;
    }

    // نحاول نجيب الكشوفات من جدول العميل نفسه
    frappe.call({
        method: "frappe.client.get",
        args: {
            doctype: "Customer",
            name: frm.doc.customer
        },
        callback(r) {
            const customer = r.message;
            if (!customer) {
                wrapper.html(`<div class="text-muted small">لم يتم العثور على بيانات العميل.</div>`);
                return;
            }

            const target_field = dialog.custom_eye_table_field || CUSTOMER_EXAMS_CHILD_FIELD;

            let arr = customer[target_field] || [];

            const FN = dialog.custom_eye_col_map || EYE_EXAM_FIELDNAMES;

            if (!arr.length) {
                wrapper.html(`<div class="text-muted small">لا توجد كشوفات سابقة لهذا العميل.</div>`);
                return;
            }

            let html = `
                <table class="table table-bordered table-condensed" style="table-layout: fixed; width: 100%;">
                    <thead>
                        <tr style="background:#f5f5f5;">
                            <th style="width:40px;">#</th>
                            <th style="width:100px;">تاريخ</th>
                            <th>SPH-R</th>
                            <th>CYL-R</th>
                            <th>Axis-R</th>
                            <th>ADD-R</th>
                            <th>PD-R</th>
                            <th>SPH-L</th>
                            <th>CYL-L</th>
                            <th>Axis-L</th>
                            <th>ADD-L</th>
                            <th>PD-L</th>
                            <th style="width:80px;">اختيار</th>
                        </tr>
                    </thead>
                    <tbody>
            `;

            arr.forEach((row, idx) => {
                html += `
                    <tr>
                        <td>${idx + 1}</td>
                        <td style="word-wrap: break-word;">${frappe.format(row[FN.date], { fieldtype: "Date" }) || ""}</td>
                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(row[FN.sph_r] || "")}</td>
                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(row[FN.cyl_r] || "")}</td>
                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(row[FN.axis_r] || "")}</td>
                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(row[FN.add_r] || "")}</td>
                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(row[FN.pd_r] || "")}</td>

                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(row[FN.sph_l] || "")}</td>
                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(row[FN.cyl_l] || "")}</td>
                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(row[FN.axis_l] || "")}</td>
                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(row[FN.add_l] || "")}</td>
                        <td style="word-wrap: break-word;">${frappe.utils.escape_html(row[FN.pd_l] || "")}</td>

                        <td>
                            <button class="btn btn-xs btn-primary so-eye-use" data-idx="${idx}">
                                ${__("استخدام")}
                            </button>
                        </td>
                    </tr>
                `;
            });

            html += `
                    </tbody>
                </table>
            `;

            wrapper.html(html);

            // عند الضغط على "استخدام" ننسخ الكشف إلى الجزء العلوي وإلى جدول الأمر
            wrapper.find(".so-eye-use").on("click", function () {
                const idx = parseInt($(this).attr("data-idx"), 10);
                const row = arr[idx];

                const exam = {
                    date:  row[FN.date],
                    sph_r: row[FN.sph_r],
                    cyl_r: row[FN.cyl_r],
                    axis_r: row[FN.axis_r],
                    add_r: row[FN.add_r],
                    pd_r:  row[FN.pd_r],

                    sph_l: row[FN.sph_l],
                    cyl_l: row[FN.cyl_l],
                    axis_l: row[FN.axis_l],
                    add_l: row[FN.add_l],
                    pd_l:  row[FN.pd_l]
                };

                // نملأ الفورم العلوي بالكشف المختار
                dialog.set_value("exam_date", exam.date);
                dialog.set_value("sph_r", exam.sph_r);
                dialog.set_value("cyl_r", exam.cyl_r);
                dialog.set_value("axis_r", exam.axis_r);
                dialog.set_value("add_r", exam.add_r);
                dialog.set_value("pd_r", exam.pd_r);

                dialog.set_value("sph_l", exam.sph_l);
                dialog.set_value("cyl_l", exam.cyl_l);
                dialog.set_value("axis_l", exam.axis_l);
                dialog.set_value("add_l", exam.add_l);
                dialog.set_value("pd_l", exam.pd_l);

                // نخلي جدول هذا الأمر يحتوي هذا الكشف فقط
                dialog.order_exams = [exam];
                render_order_exam_table(frm, dialog);

                // ونربطه بجدول أمر البيع (لو موجود)
                link_exam_to_sales_order_child(frm, exam, dialog.custom_eye_col_map);
            });
        },
        error(err) {
            console.error("Error loading previous eye exams", err);
            wrapper.html(`
                <div class="text-danger small">
                    تعذر تحميل الكشوفات السابقة (صلاحيات أو مشكلة في الاتصال).
                </div>
            `);
        }
    });
}
