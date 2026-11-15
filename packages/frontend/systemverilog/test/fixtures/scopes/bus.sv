interface bus_if;
  task drive();
  endtask
endinterface

class drv;
  virtual bus_if vif;
  task go();
    vif.drive();
  endtask
endclass
